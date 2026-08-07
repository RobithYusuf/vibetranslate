import { useState, useRef, useEffect, useMemo, type ReactNode } from 'react';
import { ChevronDown, Search } from 'lucide-react';

interface Option {
  value: string;
  label: string;
  description?: string; // optional dim second line under the label (kept out of the trigger)
  icon?: ReactNode;     // optional small leading icon (SVG), shown in rows and the trigger
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  className?: string;
  maxHeight?: number;
  minWidth?: number;
  dropUp?: boolean; // Force dropdown to open upward
  searchable?: boolean; // show a filter box when there are many options
}

export function Select({ value, onChange, options, className = '', maxHeight = 200, minWidth, dropUp = false, searchable = false }: SelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [openDirection, setOpenDirection] = useState<'up' | 'down'>('down');
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find(o => o.value === value);
  // Show the search box only when it actually helps (many options).
  const showSearch = searchable && options.length > 8;
  const filteredOptions = useMemo(() => {
    if (!showSearch || !query.trim()) return options;
    const q = query.toLowerCase();
    return options.filter(o => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
  }, [options, query, showSearch]);
  
  // Width from longest option, but CAPPED so a very long model id (e.g.
  // "meta-llama/llama-3.3-70b-instruct:free") can't blow out the layout.
  // The trigger + dropdown items truncate, so the container never needs to be wide.
  const longestLabel = options.reduce((max, opt) => opt.label.length > max.length ? opt.label : max, '');
  const calculatedMinWidth = minWidth || Math.min(Math.max(longestLabel.length * 8 + 40, 100), 240);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Determine dropdown direction based on available space
  useEffect(() => {
    if (isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      
      if (dropUp || (spaceBelow < maxHeight && spaceAbove > spaceBelow)) {
        setOpenDirection('up');
      } else {
        setOpenDirection('down');
      }
    }
  }, [isOpen, maxHeight, dropUp]);

  // Scroll to selected item when opened
  useEffect(() => {
    if (isOpen && dropdownRef.current) {
      const selectedEl = dropdownRef.current.querySelector('[data-selected="true"]');
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [isOpen]);

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
    setQuery('');
  };

  return (
    <div ref={containerRef} className={`relative ${className}`} style={{ minWidth: calculatedMinWidth }}>
      <button
        type="button"
        onClick={() => { setIsOpen(!isOpen); setQuery(''); }}
        className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-[13px] text-left bg-[#3c3c3c] border border-[#454545] rounded focus:border-[#0078d4] focus:outline-none hover:bg-[#454545] transition-colors whitespace-nowrap"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {selectedOption?.icon && <span className="shrink-0 inline-flex text-white/70">{selectedOption.icon}</span>}
          <span className="truncate">{selectedOption?.label || 'Select...'}</span>
        </span>
        <ChevronDown size={14} className={`flex-shrink-0 text-white/50 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className={`absolute left-0 right-0 z-50 bg-[#2d2d2d] border border-[#454545] rounded shadow-lg overflow-hidden flex flex-col ${
            openDirection === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
          style={{ maxHeight }}
        >
          {showSearch && (
            <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[#454545] bg-[#252526] shrink-0">
              <Search size={13} className="text-white/40 shrink-0" />
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models…"
                className="w-full bg-transparent text-[12px] text-white/90 placeholder-white/30 focus:outline-none"
              />
            </div>
          )}
          <div className="overflow-y-auto overflow-x-hidden">
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-white/40">No matches</div>
            ) : filteredOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                data-selected={option.value === value}
                onClick={() => handleSelect(option.value)}
                className={`w-full px-3 py-1.5 text-left hover:bg-[#094771] transition-colors ${
                  option.value === value ? 'bg-[#0078d4] text-white' : 'text-white/90'
                }`}
                title={option.description ? `${option.label} — ${option.description}` : option.label}
              >
                <span className="flex items-center gap-1.5 text-[13px] min-w-0">
                  {option.icon && <span className="shrink-0 inline-flex">{option.icon}</span>}
                  <span className="truncate">{option.label}</span>
                </span>
                {option.description && (
                  <span className={`block text-[10px] leading-snug truncate ${
                    option.value === value ? 'text-white/70' : 'text-white/40'
                  }`}>
                    {option.description}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default Select;
