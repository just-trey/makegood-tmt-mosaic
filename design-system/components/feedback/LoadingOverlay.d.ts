export interface LoadingOverlayProps {
  visible?: boolean;
  /** @default 'Working…' */
  label?: string;
}
/**
 * @startingPoint section="Feedback" subtitle="Full-surface busy overlay with spinner" viewport="320x180"
 */
export declare function LoadingOverlay(props: LoadingOverlayProps): JSX.Element;
