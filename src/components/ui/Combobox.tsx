"use client";

import { useEffect, useId, useRef, useState } from "react";

export interface ComboboxOption {
  value: string;
  label: string;
}

const FIELD_CLASS =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60";

/**
 * A lightweight, dependency-free combobox: click it like a dropdown, or
 * start typing immediately to filter — no external combobox library
 * (Headless UI, react-select, etc.) needed for 3 fields, and this way it
 * shares the exact same input styling as every other field in the
 * checkout form instead of inheriting a library's own look.
 *
 * `value` is always the canonical, committed value (an option's `value`,
 * e.g. an ISO country/state code — or arbitrary free text when
 * `allowFreeText` is on). The visible input text is a separate, local
 * "in-progress" string that only becomes the committed `value` when the
 * user picks an option (always) or types free text (only if
 * `allowFreeText`) — this is what makes Country/State reject arbitrary
 * text (typing alone never calls `onChange`; only selecting a listed
 * option does) while City still accepts anything typed.
 *
 * `options` is expected to already be small (a few hundred items at
 * most — countries, US states, etc.), so filtering is a plain synchronous
 * `.filter()` on every keystroke; no debounce is needed at this scale (a
 * network-backed version of this component would want one, but there's no
 * such data source anywhere in this app).
 */
export function Combobox({
  id,
  options,
  value,
  onChange,
  placeholder,
  disabled = false,
  allowFreeText = false,
  noResultsText = "No results found",
}: {
  id?: string;
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  allowFreeText?: boolean;
  noResultsText?: string;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listboxId = `${inputId}-listbox`;

  function labelFor(optionValue: string): string {
    return options.find((option) => option.value === optionValue)?.label ?? optionValue;
  }

  const [query, setQuery] = useState(() => labelFor(value));
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep the visible text in sync with the committed value whenever it
  // changes from *outside* this component (e.g. the parent clearing State
  // because Country just changed) — but only while the field isn't
  // actively being edited, so a value update never clobbers an in-flight
  // keystroke. Adjusted directly during render (React's own documented
  // "adjust state when a prop changes" pattern, using useState rather than
  // a mutated ref so it stays correct under StrictMode's double-render)
  // rather than in an effect, since setState synchronously inside an
  // effect body just to mirror a prop is exactly what that pattern warns
  // against.
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    if (!isOpen) {
      setQuery(labelFor(value));
    }
  }

  // Click-away closes the list and, for strict (non-free-text) fields,
  // snaps the visible text back to the last committed value — typing
  // something that was never actually selected must not silently become
  // the value (see this component's own doc comment above).
  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        if (!allowFreeText) {
          setQuery(labelFor(value));
        }
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, allowFreeText]);

  // While the visible text still matches the committed value's own label
  // exactly (i.e. the user hasn't changed anything since opening), show
  // every option rather than "filtering" down to just the one that
  // already matches itself — this is what lets clicking the field reveal
  // the full list instead of a single-item list.
  const isUnmodified = query === labelFor(value);
  const trimmedQuery = query.trim().toLowerCase();
  const filteredOptions =
    isUnmodified || trimmedQuery === ""
      ? options
      : options.filter((option) => option.label.toLowerCase().includes(trimmedQuery));

  function commitSelection(option: ComboboxOption) {
    onChange(option.value);
    setQuery(option.label);
    setIsOpen(false);
    setHighlightedIndex(-1);
  }

  function handleInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.value;
    setQuery(next);
    setIsOpen(true);
    setHighlightedIndex(next.trim() === "" ? -1 : 0);

    // Free-text fields (City) commit on every keystroke, since arbitrary
    // text is a valid final value there — strict fields (Country/State)
    // only ever commit via commitSelection, enforcing "must pick a real
    // option."
    if (allowFreeText) {
      onChange(next);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setHighlightedIndex(0);
        return;
      }
      setHighlightedIndex((prev) => Math.min(prev + 1, filteredOptions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setHighlightedIndex(filteredOptions.length - 1);
        return;
      }
      setHighlightedIndex((prev) => Math.max(prev - 1, 0));
    } else if (event.key === "Enter") {
      if (isOpen && highlightedIndex >= 0 && filteredOptions[highlightedIndex]) {
        event.preventDefault();
        commitSelection(filteredOptions[highlightedIndex]);
      }
    } else if (event.key === "Escape") {
      if (isOpen) {
        event.preventDefault();
        setIsOpen(false);
        if (!allowFreeText) {
          setQuery(labelFor(value));
        }
      }
    }
  }

  // A free-text field with no options at all (City, for a country/state
  // this app has no city list for — see location-data.ts) has nothing to
  // search against in the first place. Rather than opening an empty
  // dropdown that only ever says "No results found," it behaves like a
  // plain text input — that's a more honest signal than a search
  // experience that can never actually find anything.
  const showDropdown = isOpen && !disabled && (options.length > 0 || trimmedQuery !== "");

  return (
    <div ref={containerRef} className="relative">
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={showDropdown}
        aria-controls={listboxId}
        aria-autocomplete="list"
        autoComplete="off"
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        onFocus={() => setIsOpen(true)}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        className={FIELD_CLASS}
      />

      {showDropdown && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border bg-surface py-1 text-sm shadow-card"
        >
          {filteredOptions.length === 0 ? (
            <li className="px-3 py-2 text-ink-soft">{noResultsText}</li>
          ) : (
            filteredOptions.map((option, index) => (
              <li
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                // onMouseDown (not onClick) fires before the input's own
                // onBlur/click-away handler, so selecting an option can't
                // get raced by this component snapping the text back to
                // the previous value first.
                onMouseDown={(event) => {
                  event.preventDefault();
                  commitSelection(option);
                }}
                onMouseEnter={() => setHighlightedIndex(index)}
                className={`cursor-pointer px-3 py-2 ${
                  index === highlightedIndex ? "bg-inner text-ink" : "text-ink-soft"
                }`}
              >
                {option.label}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
