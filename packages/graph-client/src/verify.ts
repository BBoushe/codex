import neo4j from "neo4j-driver";

if (!process.env.NEO4J_PASSWORD) {
	throw new Error(
		"neo4j password not set. Please set the NEO4J_PASSWORD environment variable",
	);
}

const driver = neo4j.driver(
	"bolt://localhost:7687",
	neo4j.auth.basic("neo4j", process.env.NEO4J_PASSWORD),
);

const session = driver.session();

try {
	const testName = `hello-bun-${Date.now()}`;

	// 1. Create
	await session.run(
		"CREATE (n:Test {name: $name, type: 'connection-check'}) RETURN n",
		{ name: testName },
	);
	console.log(`Node created with name: ${testName}`);

	// 2. Query
	const result = await session.run("MATCH (n:Test {name: $name}) RETURN n", {
		name: testName,
	});

	if (result.records.length > 0) {
		console.log("Node queried:", result.records[0]?.get("n").properties);
	}

	// 3. Delete
	const deleteResult = await session.run(
		"MATCH (n:Test {name: $name}) DETACH DELETE n",
		{ name: testName },
	);

	console.log("Node detached and deleted");
	console.log("\n✅ Neo4j CRUD cycle verified successfully\n");
} catch (err) {
	console.error("❌ Neo4j verification failed:", err);
} finally {
	await session.close();
	await driver.close();
}
