export function LoadingOverlay({ visible = false, label = 'Working…' }) {
  if (!visible) return null;
  return (
    <div style={{
      position: 'absolute', inset: 0, background: 'rgba(13,15,17,.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10,
      fontSize: 'var(--text-md)', color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)', zIndex: 5,
    }}>
      <div style={{
        width: 26, height: 26, borderRadius: '50%', border: '2px solid var(--border-default)',
        borderTopColor: 'var(--accent-primary)', animation: 'ds-spin 0.8s linear infinite',
      }} />
      <div>{label}</div>
      <style>{'@keyframes ds-spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );
}
