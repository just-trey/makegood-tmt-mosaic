export function Dropzone({ label, filename, onFiles, accept }) {
  const [drag, setDrag] = React.useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        onFiles && onFiles(e.dataTransfer.files);
      }}
      style={{
        border: '1.5px dashed ' + (drag ? 'var(--accent-primary)' : 'var(--border-default)'),
        borderRadius: 'var(--radius-2xl)',
        padding: '18px 10px',
        textAlign: 'center',
        color: drag ? 'var(--accent-primary)' : 'var(--text-secondary)',
        background: drag ? 'var(--color-accent-teal-glow)' : 'transparent',
        cursor: 'pointer',
        fontSize: 'var(--text-md)',
        fontFamily: 'var(--font-sans)',
        transition: 'var(--transition-fast)',
      }}
    >
      {label}
      {filename && (
        <div
          style={{
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            marginTop: 4,
            wordBreak: 'break-all',
          }}
        >
          {filename}
        </div>
      )}
    </div>
  );
}
