export function Button({ children, variant = 'default', size = 'default', disabled = false, fullWidth = false, onClick }) {
  const isPrimary = variant === 'primary';
  const style = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    fontFamily: 'var(--font-sans)',
    fontSize: size === 'small' ? 'var(--text-sm)' : 'var(--text-md)',
    fontWeight: isPrimary ? 'var(--weight-semibold)' : 'var(--weight-regular)',
    padding: size === 'small' ? '3px 8px' : '7px 10px',
    borderRadius: 'var(--radius-lg)',
    border: '1px solid ' + (isPrimary ? 'var(--accent-primary)' : 'var(--border-default)'),
    background: isPrimary ? 'var(--accent-primary)' : 'var(--surface-panel-2)',
    color: isPrimary ? 'var(--on-accent)' : 'var(--text-primary)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    width: fullWidth ? '100%' : 'auto',
    transition: 'border-color var(--transition-fast), filter var(--transition-fast)',
  };
  return (
    <button
      style={style}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={(e) => { if (disabled) return; if (isPrimary) e.currentTarget.style.filter = 'brightness(1.08)'; else e.currentTarget.style.borderColor = 'var(--accent-primary)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.filter = 'none'; e.currentTarget.style.borderColor = isPrimary ? 'var(--accent-primary)' : 'var(--border-default)'; }}
    >
      {children}
    </button>
  );
}
