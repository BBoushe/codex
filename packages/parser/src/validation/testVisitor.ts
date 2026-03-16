import { LanguageService } from "../languageService";
import { TypeScriptVisitor } from "../visitors/tsVisitor";
import type { SourceFile } from "../fileWalker";

async function main() {
	const service = await LanguageService.create();
	const visitor = new TypeScriptVisitor();

	const code = `
import React, { useState, useEffect } from "react";
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

	const file: SourceFile = {
		absolutePath: "/repo/src/components/UserCard.tsx",
		relativePath: "src/components/UserCard.tsx",
		extension: ".tsx",
	};

	const tree = await service.parse(code, file.extension);
	const result = visitor.visit(tree, code, file);

	console.log("=== FILE ===");
	console.log(
		`  ${result.file.name} (${result.file.language}, ${result.file.loc} lines)\n`,
	);

	console.log("=== ENTITIES ===");
	for (const e of result.entities) {
		const n = e.node;
		console.log(`  [${n.label}] ${n.name} (${n.nodeId})`);
		if ("componentKind" in n)
			console.log(
				`    kind: ${n.componentKind}, props: [${n.props.join(", ")}]`,
			);
		if ("hookType" in n)
			console.log(
				`    hookType: ${n.hookType}, bindings: [${n.returnBindings.join(", ")}], deps: ${JSON.stringify(n.dependencies)}`,
			);
		if ("methods" in n) console.log(`    methods: [${n.methods.join(", ")}]`);
	}

	console.log("\n=== RELATIONSHIPS ===");
	for (const r of result.relationships) {
		console.log(`  ${r.sourceId} --[${r.edge.type}]--> ${r.targetId}`);
	}

	console.log("\n=== UNRESOLVED REFERENCES ===");
	for (const ref of result.unresolvedReferences) {
		if (ref.kind === "import") {
			const names = ref.importedNames.map((n) =>
				n.alias ? `${n.name} as ${n.alias}` : n.name,
			);
			console.log(
				`  [import] "${ref.specifier}" → {${names.join(", ")}}${ref.hasDefaultImport ? ` + default: ${ref.defaultOrNamespaceName}` : ""}`,
			);
		} else if (ref.kind === "call") {
			console.log(
				`  [call] ${ref.calleeName}() at L${ref.callSiteLine} from ${ref.callerNodeId}`,
			);
		} else if (ref.kind === "render") {
			console.log(
				`  [render] <${ref.componentName} /> with props: [${ref.passedProps.map((p) => p.name).join(", ")}]`,
			);
		}
	}
}

main().catch(console.error);
