type AgyLogoProps = {
  className?: string;
};

/** Rendered by the shared LLMProviderLogo when the provider is Antigravity (agy). */
const AgyLogo = ({ className = 'w-5 h-5' }: AgyLogoProps) => (
  <svg
    viewBox="0 0 512 512"
    role="img"
    aria-label="Antigravity"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient id="agyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#4F46E5" />
        <stop offset="50%" stopColor="#06B6D4" />
        <stop offset="100%" stopColor="#8B5CF6" />
      </linearGradient>
    </defs>
    <rect width="512" height="512" rx="128" fill="url(#agyGrad)" />
    <path
      d="M256 96L384 384H312L256 248L200 384H128L256 96Z"
      fill="#FFFFFF"
      fillRule="evenodd"
    />
    <circle cx="256" cy="336" r="32" fill="#FFFFFF" />
  </svg>
);

export default AgyLogo;
