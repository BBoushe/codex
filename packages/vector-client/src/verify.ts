import { ChromaClient } from "chromadb";

const client = new ChromaClient({ path: "http://localhost:8000" });

try {
	// Collection
	const collection = await client.getOrCreateCollection({ name: "test-collection" });
	console.log("Collection retrieved successfully:", collection);

	// Add data to the collection
	await collection.add({
		ids: ["test-1"],
		embeddings: [[0.1, 0.2, 0.3, 0.4, 0.5]],
		metadatas: [{ source: "verify-script" }],
		documents: ["This is a test document for verification."],
	});
	console.log("Data added successfully to the collection.");

	// Query by similarity vector
	const results = await collection.query({
		queryEmbeddings: [[0.1, 0.2, 0.3, 0.4, 0.5]],
		nResults: 1,
	});
	console.log("Query results:", results);
    console.log("\n✅ ChromaDB CRUD cycle verified successfully\n");
} catch (error) {
	console.error("An error occurred:", error);
    console.log("\n❌ ChromaDB verification failed\n");
} finally {
	await client.deleteCollection({ name: "test-collection" });
	console.log("Collection deleted successfully.");
}
