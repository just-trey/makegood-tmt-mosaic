export interface ButtonProps {
  children: React.ReactNode;
  /** @default 'default' */
  variant?: 'default' | 'primary';
  /** @default 'default' */
  size?: 'default' | 'small';
  disabled?: boolean;
  fullWidth?: boolean;
  onClick?: () => void;
}
/**
 * @startingPoint section="Forms" subtitle="Default and primary action buttons" viewport="360x120"
 */
export declare function Button(props: ButtonProps): JSX.Element;
