export interface SliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number) => void;
  /** Rendered to the right of the track, e.g. "100%" or "5%" */
  valueLabel?: string;
}
/**
 * @startingPoint section="Forms" subtitle="Range slider with live value readout" viewport="280x50"
 */
export declare function Slider(props: SliderProps): JSX.Element;
