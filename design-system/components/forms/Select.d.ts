export interface SelectOption { value: string; label: string; }
export interface SelectProps {
  options: SelectOption[];
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
}
/**
 * @startingPoint section="Forms" subtitle="Dropdown select (e.g. assembly kind)" viewport="240x60"
 */
export declare function Select(props: SelectProps): JSX.Element;
