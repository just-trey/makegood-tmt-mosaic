export function ThumbnailSelect({ options = [], value, onChange, placeholder = 'Select a part…' }) {
  const [open, setOpen] = React.useState(false);
  const current = options.find(o => o.value === value);
  return (
    <div style={{ position: 'relative', fontFamily: 'var(--font-sans)' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
          background: 'var(--surface-panel-2)', border: '1px solid ' + (open ? 'var(--accent-primary)' : 'var(--border-default)'),
          color: 'var(--text-primary)', padding: '5px 7px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
        }}
      >
        {current ? (
          <React.Fragment>
            <div style={{ width: 22, height: 22, borderRadius: 'var(--radius-sm)', overflow: 'hidden', flex: '0 0 auto', background: 'var(--surface-panel)', border: '1px solid var(--border-default)' }}>
              {current.thumbnail && <img src={current.thumbnail} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)' }}>{current.label}</span>
          </React.Fragment>
        ) : (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)', color: 'var(--text-secondary)' }}>{placeholder}</span>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20,
          background: 'var(--surface-panel-2)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)',
          maxHeight: 220, overflowY: 'auto', boxShadow: '0 4px 16px rgba(0,0,0,.4)',
        }}>
          {options.map(opt => (
            <div
              key={opt.value}
              onClick={() => { onChange && onChange(opt.value); setOpen(false); }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'var(--color-accent-teal-wash)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 7px', cursor: 'pointer' }}
            >
              <div style={{ width: 28, height: 28, borderRadius: 'var(--radius-sm)', overflow: 'hidden', flex: '0 0 auto', background: 'var(--surface-panel)', border: '1px solid var(--border-default)' }}>
                {opt.thumbnail && <img src={opt.thumbnail} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)', color: 'var(--text-primary)' }}>{opt.label}</span>
                {opt.meta && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{opt.meta}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
