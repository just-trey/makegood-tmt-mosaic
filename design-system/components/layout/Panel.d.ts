export interface PanelProps {
  /** Uppercase section label, e.g. "Artwork" or "Colors detected" */
  title?: string;
  children: React.ReactNode;
}
/**
 * @startingPoint section="Layout" subtitle="Sidebar section with uppercase label + rule" viewport="320x160"
 */
export declare function Panel(props: PanelProps): JSX.Element;
