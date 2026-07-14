export function Slider({ value, min = 0, max = 100, step = 1, onChange, valueLabel }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input
        type="range" value={value} min={min} max={max} step={step}
        onChange={(e) => onChange && onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: 'var(--accent-primary)' }}
      />
      {valueLabel !== undefined && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', minWidth: 32, textAlign: 'right' }}>{valueLabel}</span>
      )}
    </div>
  );
}
