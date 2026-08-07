interface ToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  size?: 'sm' | 'md';
  disabled?: boolean;
}

export default function Toggle({ enabled, onChange, size = 'md', disabled = false }: ToggleProps) {
  const sizes = {
    sm: { track: 'w-8 h-4', thumb: 'w-3 h-3', translate: 'translate-x-4' },
    md: { track: 'w-11 h-6', thumb: 'w-5 h-5', translate: 'translate-x-5' },
  };
  
  const s = sizes[size];
  
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={() => !disabled && onChange(!enabled)}
      className={`
        relative inline-flex shrink-0 cursor-pointer rounded-full 
        transition-colors duration-200 ease-in-out
        focus:outline-none focus:ring-2 focus:ring-[#0078d4] focus:ring-offset-2 focus:ring-offset-[#1e1e1e]
        ${s.track}
        ${enabled ? 'bg-[#0078d4]' : 'bg-[#454545]'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
    >
      <span
        className={`
          pointer-events-none inline-block rounded-full bg-white shadow-lg 
          transform transition duration-200 ease-in-out
          ${s.thumb}
          ${enabled ? s.translate : 'translate-x-0.5'}
          mt-0.5
        `}
      />
    </button>
  );
}
