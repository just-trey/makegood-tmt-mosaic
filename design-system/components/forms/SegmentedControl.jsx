export function SegmentedControl({ options = [], value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 5 }}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange && onChange(opt.value)}
            style={{
              flex: 1,
              padding: '7px 4px',
              fontSize: 'var(--text-sm)',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid ' + (active ? 'var(--accent-primary)' : 'var(--border-default)'),
              background: active ? 'var(--color-accent-teal-wash)' : 'var(--surface-panel-2)',
              color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
