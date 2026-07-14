export interface CheckboxProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}
/**
 * @startingPoint section="Forms" subtitle="Checkbox with inline label" viewport="240x50"
 */
export declare function Checkbox(props: CheckboxProps): JSX.Element;
