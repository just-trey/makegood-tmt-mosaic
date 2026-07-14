export interface SegmentedOption { value: string; label: string; }
export interface SegmentedControlProps {
  options: SegmentedOption[];
  value: string;
  onChange?: (value: string) => void;
}
/**
 * @startingPoint section="Forms" subtitle="Segmented switcher (e.g. base-part shape)" viewport="360x60"
 */
export declare function SegmentedControl(props: SegmentedControlProps): JSX.Element;
