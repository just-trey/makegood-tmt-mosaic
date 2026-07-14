export interface ThumbnailOption {
  value: string;
  label: string;
  /** Image URL shown as a small square preview */
  thumbnail?: string;
  /** Small secondary line, e.g. a file name or part count */
  meta?: string;
}
export interface ThumbnailSelectProps {
  options: ThumbnailOption[];
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
}
/**
 * @startingPoint section="Forms" subtitle="Dropdown with a thumbnail preview per option" viewport="300x70"
 */
export declare function ThumbnailSelect(props: ThumbnailSelectProps): JSX.Element;
