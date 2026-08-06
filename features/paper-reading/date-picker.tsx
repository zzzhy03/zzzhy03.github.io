"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "./date-picker.module.css";

type DatePickerProps = {
  availableDates: string[];
  currentDate: string;
  onChange: (date: string) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
};

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const weekdayLabels = ["一", "二", "三", "四", "五", "六", "日"];

function isIsoDate(value: string) {
  if (!isoDatePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

function toMonthKey(date: string) {
  return date.slice(0, 7);
}

function getMonthParts(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  return { year, month };
}

function makeMonthKey(year: number, month: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function shiftMonth(monthKey: string, amount: number) {
  const { year, month } = getMonthParts(monthKey);
  const shifted = new Date(Date.UTC(year, month - 1 + amount, 1));
  return makeMonthKey(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1);
}

function makeDate(monthKey: string, day: number) {
  return `${monthKey}-${String(day).padStart(2, "0")}`;
}

function monthLabel(monthKey: string) {
  const { year, month } = getMonthParts(monthKey);
  return `${year} 年 ${month} 月`;
}

function getMonthDays(monthKey: string) {
  const { year, month } = getMonthParts(monthKey);
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  return { count, firstWeekday };
}

export function DatePicker({
  availableDates,
  currentDate,
  onChange,
  disabled = false,
  className = "",
  ariaLabel = "选择日报日期",
}: DatePickerProps) {
  const validCurrentDate = isIsoDate(currentDate) ? currentDate : "1970-01-01";
  const normalizedDates = useMemo(
    () => [...new Set(availableDates.filter(isIsoDate))].sort(),
    [availableDates],
  );
  const availableSet = useMemo(() => new Set(normalizedDates), [normalizedDates]);
  const firstMonth = normalizedDates[0]
    ? toMonthKey(normalizedDates[0])
    : toMonthKey(validCurrentDate);
  const lastMonth = normalizedDates.at(-1)
    ? toMonthKey(normalizedDates.at(-1) as string)
    : toMonthKey(validCurrentDate);
  const [isOpen, setIsOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => toMonthKey(validCurrentDate));
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogId = useId();
  const headingId = useId();

  const { count: dayCount, firstWeekday } = getMonthDays(visibleMonth);
  const canShowPreviousMonth = visibleMonth > firstMonth;
  const canShowNextMonth = visibleMonth < lastMonth;

  useEffect(() => {
    if (!isOpen) return;

    function closeFromOutside(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    }

    function closeFromEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setIsOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const root = rootRef.current;
      const selected = root?.querySelector<HTMLButtonElement>(
        `[data-calendar-date="${validCurrentDate}"]`,
      );
      const firstAvailable = root?.querySelector<HTMLButtonElement>(
        "[data-calendar-date]:not(:disabled)",
      );
      (selected || firstAvailable)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, validCurrentDate]);

  function closeCalendar({ restoreFocus = false } = {}) {
    setIsOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function toggleCalendar() {
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    setVisibleMonth(toMonthKey(validCurrentDate));
    setIsOpen(true);
  }

  function chooseDate(date: string) {
    if (!availableSet.has(date)) return;
    onChange(date);
    closeCalendar({ restoreFocus: true });
  }

  function focusSiblingDate(date: string, direction: -1 | 1) {
    const inVisibleMonth = normalizedDates.filter(
      (candidate) => toMonthKey(candidate) === visibleMonth,
    );
    const currentIndex = inVisibleMonth.indexOf(date);
    const nextDate = inVisibleMonth[currentIndex + direction];
    if (!nextDate) return;
    rootRef.current
      ?.querySelector<HTMLButtonElement>(`[data-calendar-date="${nextDate}"]`)
      ?.focus();
  }

  function handleDayKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, date: string) {
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      focusSiblingDate(date, -1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      focusSiblingDate(date, 1);
    }
  }

  return (
    <div className={`${styles.picker} ${className}`.trim()} ref={rootRef}>
      <button
        className={styles.trigger}
        type="button"
        ref={triggerRef}
        disabled={disabled}
        aria-label={`${ariaLabel}，当前为 ${validCurrentDate}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? dialogId : undefined}
        onClick={toggleCalendar}
      >
        <time dateTime={validCurrentDate}>{validCurrentDate}</time>
      </button>

      {isOpen ? (
        <div
          className={styles.popover}
          id={dialogId}
          role="dialog"
          aria-labelledby={headingId}
        >
          <div className={styles.monthHeader}>
            <button
              className={styles.monthButton}
              type="button"
              disabled={!canShowPreviousMonth}
              aria-label="上一个月"
              onClick={() => setVisibleMonth((month) => shiftMonth(month, -1))}
            >
              <span aria-hidden="true">‹</span>
            </button>
            <h2 id={headingId} aria-live="polite">
              {monthLabel(visibleMonth)}
            </h2>
            <button
              className={styles.monthButton}
              type="button"
              disabled={!canShowNextMonth}
              aria-label="下一个月"
              onClick={() => setVisibleMonth((month) => shiftMonth(month, 1))}
            >
              <span aria-hidden="true">›</span>
            </button>
          </div>

          <div className={styles.weekdays} aria-hidden="true">
            {weekdayLabels.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>

          <div className={styles.days} role="group" aria-label={monthLabel(visibleMonth)}>
            {Array.from({ length: firstWeekday }, (_, index) => (
              <span className={styles.emptyDay} aria-hidden="true" key={`empty-${index}`} />
            ))}
            {Array.from({ length: dayCount }, (_, index) => {
              const day = index + 1;
              const date = makeDate(visibleMonth, day);
              const hasDigest = availableSet.has(date);
              const isSelected = date === validCurrentDate;
              return (
                <button
                  className={`${styles.day} ${hasDigest ? styles.availableDay : ""} ${
                    isSelected ? styles.selectedDay : ""
                  }`.trim()}
                  type="button"
                  disabled={!hasDigest}
                  data-calendar-date={date}
                  aria-label={`${date}，${hasDigest ? "有日报" : "无日报"}`}
                  aria-pressed={isSelected}
                  onClick={() => chooseDate(date)}
                  onKeyDown={(event) => handleDayKeyDown(event, date)}
                  key={date}
                >
                  {day}
                </button>
              );
            })}
          </div>

        </div>
      ) : null}
    </div>
  );
}
