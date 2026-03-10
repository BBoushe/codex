TODO Fix this file up

// ============================================================
// CODEX — Neo4j Schema Initialization
//
// Placement: packages/graph-client/src/schema.cypher
//
// Run this ONCE against a fresh Neo4j database to set up
// constraints and indexes. Constraints also create implicit
// indexes, so we only add explicit indexes where needed
// for query patterns that don't match a constraint.
//
// Usage (from graph-client):
//   Read this file → split on semicolons → execute each
//   statement in a Neo4j session.
//
// NOTE: Neo4j Community Edition supports uniqueness constraints
// and index creation, but NOT existence constraints or
// property type constraints (those require Enterprise).
// We work within Community Edition limits here.
// ============================================================

// ─────────────────────────────────────────────────────────────
// 1. Uniqueness Constraints
//    These enforce data integrity AND create implicit indexes.
//    The `nodeId` field is our deterministic cross-reference key
//    (used to link Neo4j nodes ↔ ChromaDB vectors).
// ─────────────────────────────────────────────────────────────

// -- Structural nodes --
CREATE CONSTRAINT file_nodeId IF NOT EXISTS
  FOR (n:File) REQUIRE n.nodeId IS UNIQUE;

CREATE CONSTRAINT directory_nodeId IF NOT EXISTS
  FOR (n:Directory) REQUIRE n.nodeId IS UNIQUE;

CREATE CONSTRAINT function_nodeId IF NOT EXISTS
  FOR (n:Function) REQUIRE n.nodeId IS UNIQUE;

CREATE CONSTRAINT class_nodeId IF NOT EXISTS
  FOR (n:Class) REQUIRE n.nodeId IS UNIQUE;

// -- React-specific nodes --
CREATE CONSTRAINT component_nodeId IF NOT EXISTS
  FOR (n:Component) REQUIRE n.nodeId IS UNIQUE;

CREATE CONSTRAINT hook_nodeId IF NOT EXISTS
  FOR (n:Hook) REQUIRE n.nodeId IS UNIQUE;

CREATE CONSTRAINT prop_nodeId IF NOT EXISTS
  FOR (n:Prop) REQUIRE n.nodeId IS UNIQUE;

// -- Social nodes --
CREATE CONSTRAINT developer_nodeId IF NOT EXISTS
  FOR (n:Developer) REQUIRE n.nodeId IS UNIQUE;

CREATE CONSTRAINT commit_nodeId IF NOT EXISTS
  FOR (n:Commit) REQUIRE n.nodeId IS UNIQUE;

// -- Additional uniqueness: file paths and commit SHAs --
CREATE CONSTRAINT file_path_unique IF NOT EXISTS
  FOR (n:File) REQUIRE n.filePath IS UNIQUE;

CREATE CONSTRAINT directory_path_unique IF NOT EXISTS
  FOR (n:Directory) REQUIRE n.path IS UNIQUE;

CREATE CONSTRAINT developer_email_unique IF NOT EXISTS
  FOR (n:Developer) REQUIRE n.email IS UNIQUE;

CREATE CONSTRAINT commit_sha_unique IF NOT EXISTS
  FOR (n:Commit) REQUIRE n.sha IS UNIQUE;

// ─────────────────────────────────────────────────────────────
// 2. Lookup Indexes
//    For properties that are frequently used in WHERE clauses
//    or MATCH patterns but are NOT covered by the constraints
//    above. Constraints on nodeId already index that field,
//    so we only add indexes for other query patterns.
// ─────────────────────────────────────────────────────────────

// Name-based search (fuzzy lookup, autocomplete, "find function X")
CREATE INDEX function_name IF NOT EXISTS
  FOR (n:Function) ON (n.name);

CREATE INDEX class_name IF NOT EXISTS
  FOR (n:Class) ON (n.name);

CREATE INDEX component_name IF NOT EXISTS
  FOR (n:Component) ON (n.name);

CREATE INDEX hook_hookType IF NOT EXISTS
  FOR (n:Hook) ON (n.hookType);

CREATE INDEX prop_name IF NOT EXISTS
  FOR (n:Prop) ON (n.name);

// File path prefix queries (e.g. "all entities in src/services/")
CREATE INDEX function_filePath IF NOT EXISTS
  FOR (n:Function) ON (n.filePath);

CREATE INDEX class_filePath IF NOT EXISTS
  FOR (n:Class) ON (n.filePath);

CREATE INDEX component_filePath IF NOT EXISTS
  FOR (n:Component) ON (n.filePath);

// Developer name lookup
CREATE INDEX developer_name IF NOT EXISTS
  FOR (n:Developer) ON (n.name);

// Commit timestamp for time-range queries (Phase 3)
CREATE INDEX commit_timestamp IF NOT EXISTS
  FOR (n:Commit) ON (n.timestamp);

// ─────────────────────────────────────────────────────────────
// 3. Composite Indexes (for common multi-property lookups)
// ─────────────────────────────────────────────────────────────

// "Find function X in file Y" — the most common parser lookup
// when resolving CALLS edges across files
CREATE INDEX function_file_name IF NOT EXISTS
  FOR (n:Function) ON (n.filePath, n.name);

CREATE INDEX component_file_name IF NOT EXISTS
  FOR (n:Component) ON (n.filePath, n.name);

CREATE INDEX class_file_name IF NOT EXISTS
  FOR (n:Class) ON (n.filePath, n.name);
