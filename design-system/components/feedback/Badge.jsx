export function Badge({ children, tone = 'neutral' }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-sm)',
        color: tone === 'accent' ? 'var(--accent-secondary)' : 'var(--text-secondary)',
      }}
    >
      {children}
    </span>
  );
}
