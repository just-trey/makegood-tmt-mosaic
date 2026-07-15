export function Panel({ title, children }) {
  return (
    <section style={{ marginBottom: 'var(--space-8)' }}>
      {title && (
        <h2
          style={{
            fontSize: 'var(--text-xs)',
            textTransform: 'uppercase',
            letterSpacing: 'var(--tracking-label)',
            color: 'var(--text-secondary)',
            margin: '0 0 var(--space-3) 0',
            fontWeight: 'var(--weight-bold)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {title}
          <span style={{ flex: 1, height: 1, background: 'var(--border-default)' }} />
        </h2>
      )}
      {children}
    </section>
  );
}
