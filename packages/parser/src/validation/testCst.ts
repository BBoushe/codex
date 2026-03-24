import { LanguageService } from "../languageService";

async function main() {
	const service = await LanguageService.create();

	const code = `
import React, { useState } from "react";
import { fetchUser } from "./api/user";

interface UserCardProps {
  userId: string;
  onSelect?: (id: string) => void;
}

export const UserCard: React.FC<UserCardProps> = ({ userId, onSelect }) => {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    fetchUser(userId).then(setUser);
  }, [userId]);

  const handleClick = () => {
    onSelect?.(userId);
  };

  return (
    <div onClick={handleClick}>
      <Avatar src={user?.avatar} />
      <span>{user?.name}</span>
    </div>
  );
};

export function formatName(first: string, last: string): string {
  return first + " " + last;
}

export class UserService {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async getUser(id: string): Promise<User> {
    return fetch(this.baseUrl + "/users/" + id).then(r => r.json());
  }
}
`;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const code2 = `
import React, { 
  useState, 
  useEffect, 
  useContext, 
  useReducer, 
  useCallback,
  useMemo,
  useRef,
  useLayoutEffect,
  useDebugValue
} from 'react';

// ============ CONTEXT ============
const ThemeContext = React.createContext('light');

// ============ REDUCER ============
const initialState = { count: 0 };
const reducer = (state, action) => {
  switch(action.type) {
    case 'INCREMENT': return { count: state.count + 1 };
    case 'DECREMENT': return { count: state.count - 1 };
    default: return state;
  }
};

// ============ CUSTOM HOOK ============
function useCustomHook(initialValue) {
  const [value, setValue] = useState(initialValue);
  useDebugValue(value > 0 ? \`Value: \${value}\` : 'No value');
  return [value, setValue];
}

// ============ FUNCTION COMPONENT WITH ALL HOOKS ============
function ComplexComponent({ 
  title = 'Default Title', 
  items = [], 
  onItemSelect = () => {},
  ...props 
}) {
  // Hooks
  const [count, setCount] = useState(0);
  const [state, dispatch] = useReducer(reducer, initialState);
  const theme = useContext(ThemeContext);
  const [customVal, setCustomVal] = useCustomHook(5);
  const inputRef = useRef(null);
  const memoRef = useRef({ cached: false });

  // Effect hooks
  useEffect(() => {
    console.log('Mount/update:', count);
    return () => console.log('Cleanup');
  }, [count]);

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Memoized callbacks
  const handleIncrement = useCallback(() => {
    setCount(c => c + 1);
    dispatch({ type: 'INCREMENT' });
  }, []);

  const handleItemClick = useCallback((item) => {
    onItemSelect(item);
    console.log('Selected:', item);
  }, [onItemSelect]);

  // Memoized values
  const expensiveValue = useMemo(() => {
    return items.reduce((acc, item) => acc + (item.value || 0), 0);
  }, [items]);

  const filteredItems = useMemo(() => {
    return items.filter(item => item.active !== false);
  }, [items]);

  // Conditional rendering
  const renderContent = () => {
    if (!items.length) {
      return <p>No items available</p>;
    }
    return (
      <ul>
        {items.map((item, idx) => (
          <li key={item.id || idx} onClick={() => handleItemClick(item)}>
            {item.name} - {item.value}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <ThemeContext.Provider value={theme}>
      <div className="container" style={{ background: theme === 'dark' ? '#333' : '#fff' }}>
        <h1>{title}</h1>
        <p>Count: {count} | State: {state.count}</p>
        <p>Custom: {customVal}</p>
        <p>Sum: {expensiveValue}</p>

        <button onClick={handleIncrement}>Increment</button>
        <input ref={inputRef} defaultValue="Focus me" />

        {/* Fragment with key */}
        <>
          {filteredItems.length && renderContent()}
        </>

        {/* Conditional ternary */}
        {count > 5 ? <p>Count is high!</p> : <p>Count is low</p>}

        {/* Logical AND */}
        {customVal > 0 && <p>Custom value is positive</p>}

        {/* Spread attributes */}
        <div {...props} data-theme={theme} />

        {/* Fragment with key (explicit) */}
        <React.Fragment key="fragment">
          <span>Fragment child 1</span>
          <span>Fragment child 2</span>
        </React.Fragment>
      </div>
    </ThemeContext.Provider>
  );
}

// ============ FORWARDREF COMPONENT ============
const InputField = React.forwardRef(({ label, ...props }, ref) => (
  <div>
    <label>{label}</label>
    <input ref={ref} {...props} />
  </div>
));

InputField.displayName = 'InputField';

// ============ MEMO COMPONENT ============
const MemoChild = React.memo(({ count, onUpdate }) => {
  console.log('MemoChild render');
  return <button onClick={onUpdate}>Count: {count}</button>;
}, (prevProps, nextProps) => {
  return prevProps.count === nextProps.count;
});

// ============ LAZY + SUSPENSE ============
const LazyComponent = React.lazy(() => import('./LazyComponent'));

function LazyLoader() {
  return (
    <React.Suspense fallback={<div>Loading...</div>}>
      <LazyComponent />
    </React.Suspense>
  );
}

// ============ CLASS COMPONENT (Legacy) ============
class ClassComponent extends React.Component {
  constructor(props) {
    super(props);
    this.state = { count: 0 };
  }

  componentDidMount() {
    console.log('Class mounted');
  }

  componentDidUpdate(prevProps, prevState) {
    if (prevState.count !== this.state.count) {
      console.log('Count changed');
    }
  }

  componentWillUnmount() {
    console.log('Class unmounting');
  }

  render() {
    const { count } = this.state;
    return (
      <div>
        <p>Class Count: {count}</p>
        <button onClick={() => this.setState({ count: count + 1 })}>
          Class Increment
        </button>
      </div>
    );
  }
}

// ============ ARROW FUNCTION COMPONENT ============
const ArrowComponent = ({ message }) => <p>{message}</p>;

// ============ CHILDREN AS FUNCTION (Render Props) ============
class RenderPropsComponent extends React.Component {
  state = { data: 'RenderPropsData' };

  render() {
    return this.props.children(this.state.data);
  }
}

// ============ JSX SPREAD ATTRIBUTES ============
function ComponentWithSpread({ first, second, ...rest }) {
  return <div first={first} second={second} {...rest} />;
}

// ============ HOC (Higher Order Component) ============
function withTheme(Component) {
  return function ThemedComponent(props) {
    const theme = useContext(ThemeContext);
    return <Component {...props} theme={theme} />;
  };
}

const ThemedComplexComponent = withTheme(ComplexComponent);

// ============ EXPORT ============
export default function App() {
  const [items] = useState([
    { id: 1, name: 'Item 1', value: 10, active: true },
    { id: 2, name: 'Item 2', value: 20, active: true },
    { id: 3, name: 'Item 3', value: 30, active: false },
  ]);

  const handleItemSelect = useCallback((item) => {
    console.log('App selected:', item);
  }, []);

  return (
    <ThemeContext.Provider value="light">
      <div>
        <ComplexComponent 
          title="React Feature Test"
          items={items}
          onItemSelect={handleItemSelect}
          data-test="app"
        />
        <ClassComponent />
        <ArrowComponent message="Arrow component" />
        <RenderPropsComponent>
          {(data) => <p>Render props: {data}</p>}
        </RenderPropsComponent>
        <MemoChild count={0} onUpdate={() => {}} />
        <InputField label="Test Input" ref={React.createRef()} />
        <ThemedComplexComponent title="HOC Component" items={items} />
        <LazyLoader />
      </div>
    </ThemeContext.Provider>
  );
}
`;

	const tree = await service.parse(code, ".tsx");

	function printTree(
		node: ReturnType<typeof tree.rootNode.child>,
		depth = 0,
	): void {
		if (!node) return;
		const indent = "  ".repeat(depth);
		const preview =
			node.text.length > 60 ? node.text.slice(0, 60) + "..." : node.text;
		// Only print named nodes to reduce noise
		if (node.isNamed) {
			console.log(
				`${indent}${node.type} [${node.startPosition.row}:${node.startPosition.column}] "${preview}"`,
			);
		}
		for (const child of node.children) {
			printTree(child, depth + 1);
		}
	}

	// Print only top-level children in detail
	for (const child of tree.rootNode.children) {
		console.log(
			`\n=== ${child.type} (line ${child.startPosition.row + 1}) ===`,
		);
		printTree(child, 1);
		console.log();
	}
}

main().catch(console.error);
