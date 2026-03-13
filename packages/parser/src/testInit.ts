import { LanguageService, SUPPORTED_EXTENSIONS } from "./languageService";

async function main() {
	console.log("Supported extensions:", SUPPORTED_EXTENSIONS);

	const service = await LanguageService.create();

	const tsxCode = `
    import React from "react";
    
    interface Props {
        name: stirng
    }
        
    export function Greeting({ name }: Props) {
        const [count, setCount] = React.useState(0);
        return <div>Hello {name}, count: {count}</div>;
    }
    `;

	const tree = await service.parse(tsxCode, ".tsx");
	console.log("Root node type:", tree.rootNode.type);
	console.log("Child count: ", tree.rootNode.childCount);
	console.log("\nCST (depth 3):");

	for (const child of tree.rootNode.children) {
		console.log(
			`   ${child.type} [${child.startPosition.row}:${child.startPosition.column}]`,
		);
		for (const grandChild of child.children) {
			console.log(
				`       ${grandChild.type}: ${grandChild.text.slice(0, 120)}`,
			);

			for (const greatGrandChild of grandChild.children) {
				console.log(
					`           ${greatGrandChild.type}: ${greatGrandChild.text.slice(0, 120)}`,
				);
			}
		}
	}
}

main().catch(console.error);
