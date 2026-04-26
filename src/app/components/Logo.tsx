interface LogoProps {
  className?: string;
}

export function Logo({ className }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      fill="none"
    >
      <path
        d="M5 5 L11 5 L8 19 L2 19 Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M11 5 L17 5 L14 19 L8 19 Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M17 5 L23 5 L20 19 L14 19 Z"
        className="text-blue-400"
        fill="currentColor"
      />
    </svg>
  );
}
