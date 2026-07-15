export function TextInput({
  type = 'text',
  value,
  onChange,
  placeholder,
  min,
  max,
  step,
  disabled = false,
}) {
  const style = {
    width: '100%',
    boxSizing: 'border-box',
    background: 'var(--surface-panel-2)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-primary)',
    padding: '5px 7px',
    borderRadius: 'var(--radius-md)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-md)',
    outline: 'none',
    opacity: disabled ? 0.4 : 1,
  };
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      style={style}
      onChange={(e) => onChange && onChange(e.target.value)}
      onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--accent-primary)')}
      onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-default)')}
    />
  );
}
