import crossSpawn from 'cross-spawn';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  flattenPromptForWindowsShell,
} from '@/shared/utils.js';
import { resolveAgyCommand } from '@/modules/providers/list/agy/agy-auth.provider.js';

const spawnFunction = crossSpawn;
const activeAgyProcesses = new Map();

async function spawnAgy(command, options = {}, ws, context) {
  const providerSessionId = context.resolveProviderSessionId(options.sessionId);
  const resolvedModel = await context.resolveResumeModel(options.sessionId, options.model);

  return new Promise((resolve, reject) => {
    const {
      sessionId,
      projectPath,
      cwd,
      skipPermissions,
      sessionSummary,
      effort,
      permissionMode,
    } = options;

    let capturedSessionId = providerSessionId;
    let sessionCreatedSent = false;
    let completeSent = false;
    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;

    const baseArgs = [];

    if (providerSessionId) {
      baseArgs.push('--conversation', providerSessionId);
    }

    if (command && command.trim()) {
      baseArgs.push('-p', flattenPromptForWindowsShell(command));
      baseArgs.push('--output-format', 'stream-json');
    }

    if (resolvedModel) {
      baseArgs.push('--model', resolvedModel);
    }

    if (effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
      baseArgs.push('--effort', effort);
    }

    if (skipPermissions || permissionMode === 'bypassPermissions') {
      baseArgs.push('--dangerously-skip-permissions');
    } else if (permissionMode === 'plan') {
      baseArgs.push('--mode', 'plan');
    }

    const workingDir = cwd || projectPath || process.cwd();
    const processKey = sessionId || Date.now().toString();

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }
      terminalNotificationSent = true;
      const finalSessionId = sessionId || capturedSessionId || processKey;

      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'agy',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'agy',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `agy CLI exited with code ${code}`,
      });
    };

    const agyBin = resolveAgyCommand();
    const agyProcess = spawnFunction(agyBin, baseArgs, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    activeAgyProcesses.set(processKey, agyProcess);

    const processAgyLine = (line) => {
      if (!line || !line.trim()) {
        return;
      }

      try {
        const event = JSON.parse(line);

        if (event.event === 'init') {
          if (event.conversation_id && !capturedSessionId) {
            capturedSessionId = event.conversation_id;

            if (!sessionId && processKey !== capturedSessionId) {
              activeAgyProcesses.delete(processKey);
              activeAgyProcesses.set(capturedSessionId, agyProcess);
            }

            if (ws.setSessionId && typeof ws.setSessionId === 'function') {
              ws.setSessionId(capturedSessionId);
            }

            if (!providerSessionId && !sessionCreatedSent) {
              sessionCreatedSent = true;
              ws.send(createNormalizedMessage({
                kind: 'session_created',
                newSessionId: capturedSessionId,
                sessionId: capturedSessionId,
                provider: 'agy',
                model: resolvedModel || 'gemini-3.8-flash-high',
                cwd: event.init?.cwd || workingDir,
              }));
            }
          }
        } else if (event.event === 'step_update') {
          const step = event.step_update;
          if (step.thinking_delta) {
            ws.send(createNormalizedMessage({
              kind: 'thinking',
              content: step.thinking_delta,
              sessionId: capturedSessionId || sessionId || null,
              provider: 'agy',
            }));
          }

          if (step.text_delta) {
            ws.send(createNormalizedMessage({
              kind: 'stream_delta',
              content: step.text_delta,
              sessionId: capturedSessionId || sessionId || null,
              provider: 'agy',
            }));
          }
        } else if (event.event === 'result') {
          if (!completeSent) {
            completeSent = true;
            ws.send(createCompleteMessage({
              provider: 'agy',
              sessionId: capturedSessionId || sessionId || null,
              exitCode: event.result?.status === 'SUCCESS' ? 0 : 1,
            }));
          }
        }
      } catch {
        // Non-JSON line from stderr or info output
        const normalized = context.normalizeMessage(line, capturedSessionId || sessionId || null);
        for (const msg of normalized) {
          ws.send(msg);
        }
      }
    };

    agyProcess.stdout.on('data', (data) => {
      stdoutLineBuffer += data.toString();
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() || '';
      lines.forEach((l) => processAgyLine(l.trim()));
    });

    agyProcess.stderr.on('data', (data) => {
      const errText = data.toString();
      console.error('agy stderr:', errText);
    });

    agyProcess.on('error', (err) => {
      activeAgyProcesses.delete(processKey);
      notifyTerminalState({ error: err.message });
      if (!completeSent) {
        completeSent = true;
        ws.send(createCompleteMessage({
          provider: 'agy',
          sessionId: capturedSessionId || sessionId || null,
          exitCode: 1,
        }));
      }
      reject(err);
    });

    agyProcess.on('close', (code) => {
      activeAgyProcesses.delete(processKey);
      if (stdoutLineBuffer.trim()) {
        processAgyLine(stdoutLineBuffer.trim());
        stdoutLineBuffer = '';
      }

      if (!completeSent) {
        completeSent = true;
        ws.send(createCompleteMessage({
          provider: 'agy',
          sessionId: capturedSessionId || sessionId || null,
          exitCode: code ?? 0,
        }));
      }

      notifyTerminalState({ code });
      resolve({ sessionId: capturedSessionId || sessionId, exitCode: code });
    });
  });
}

function abortAgy(sessionId) {
  const proc = activeAgyProcesses.get(sessionId);
  if (proc) {
    proc.kill('SIGTERM');
    activeAgyProcesses.delete(sessionId);
    return true;
  }
  return false;
}

export const agyRuntime = {
  run: spawnAgy,
  abort: abortAgy,
};
