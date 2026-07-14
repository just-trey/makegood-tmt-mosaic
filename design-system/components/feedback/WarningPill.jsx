export function WarningPill({ children }) {
  return (
    <div style={{
      background: 'var(--state-danger-wash)', border: '1px solid var(--state-danger-border)',
      color: 'var(--state-danger-text)', padding: '6px 10px', borderRadius: 'var(--radius-lg)',
      fontSize: 'var(--text-sm-plus)', fontFamily: 'var(--font-sans)', maxWidth: 520,
    }}>
      {children}
    </div>
  );
}
