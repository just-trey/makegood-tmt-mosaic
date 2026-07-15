export function ColorRow({ hex, areaPct, depth, onDepthChange, selected, onSelectedChange }) {
  return (
    <div
      style={{
        background: 'var(--surface-panel-2)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-xl)',
        padding: '7px 8px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {onSelectedChange && (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={(e) => onSelectedChange(e.target.checked)}
            style={{ accentColor: 'var(--accent-primary)', width: 14, height: 14 }}
          />
        )}
        <div
          style={{
            width: 16,
            height: 16,
            borderRadius: 'var(--radius-sm)',
            border: '1px solid rgba(255,255,255,.15)',
            background: hex,
            flex: '0 0 auto',
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          {hex}
        </span>
        {areaPct !== undefined && (
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              color: 'var(--text-secondary)',
            }}
          >
            {areaPct}%
          </span>
        )}
      </div>
      {onDepthChange && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <label style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
            depth
          </label>
          <input
            type="number"
            value={depth}
            step={0.05}
            onChange={(e) => onDepthChange(Number(e.target.value))}
            style={{
              width: 64,
              flex: 'none',
              background: 'var(--surface-panel)',
              border: '1px solid var(--border-default)',
              color: 'var(--text-primary)',
              padding: '5px 7px',
              borderRadius: 'var(--radius-md)',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-md)',
              outline: 'none',
            }}
          />
        </div>
      )}
    </div>
  );
}
