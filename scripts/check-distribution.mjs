#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const pkg = readJson('package.json');
const agentPlugin = readJson('plugin.json');
const agentMcp = readJson('mcp.json');
const claudePlugin = readJson('.claude-plugin/plugin.json');
const claudeMcp = readJson('.mcp.json');
const gemini = readJson('gemini-extension.json');
const registry = readJson('server.json');
const copilotMarketplace = readJson('.github/plugin/marketplace.json');

const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

const endpoint = 'https://remcp.site/mcp';
const version = pkg.version;

check(agentPlugin.$schema === 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'plugin.json must stay Agent Plugins 1.0');
check(agentPlugin.name === 'remcp', 'plugin.json name must stay remcp');
check(agentPlugin.version === version, 'plugin.json version must match package.json');
check(agentMcp?.mcpServers?.remcp?.url === endpoint, 'mcp.json must point at the production MCP endpoint');

check(claudePlugin.version === version, 'Claude plugin version must match package.json');
check(claudeMcp?.mcpServers?.remcp?.url === endpoint, 'Claude MCP config must point at the production MCP endpoint');

check(gemini.name === 'remcp', 'Gemini extension name must be remcp');
check(gemini.version === version, 'Gemini extension version must match package.json');
check(gemini?.mcpServers?.remcp?.url === endpoint, 'Gemini extension must point at the production MCP endpoint');
check(gemini?.mcpServers?.remcp?.type === 'http', 'Gemini extension must use Streamable HTTP');
check(gemini?.mcpServers?.remcp?.authProviderType === 'dynamic_discovery', 'Gemini extension must use OAuth dynamic discovery');

check(registry.name === 'io.github.antonbaider/remcp', 'MCP Registry name must stay in the GitHub-authenticated namespace');
check(registry.version === version, 'MCP Registry server version must match package.json');
check(registry?.repository?.url === 'https://github.com/antonbaider/remcp', 'MCP Registry repository must point at the public repo');
check(registry?.remotes?.length === 1, 'MCP Registry record must expose exactly one production remote');
check(registry?.remotes?.[0]?.type === 'streamable-http', 'MCP Registry remote must use Streamable HTTP');
check(registry?.remotes?.[0]?.url === endpoint, 'MCP Registry remote must point at the production MCP endpoint');

check(copilotMarketplace.name === 'remcp', 'Copilot marketplace name must be remcp');
check(copilotMarketplace?.metadata?.version === version, 'Copilot marketplace version must match package.json');
check(copilotMarketplace?.plugins?.length === 1, 'Copilot marketplace must expose exactly one ReMCP plugin');
check(copilotMarketplace?.plugins?.[0]?.name === 'remcp', 'Copilot marketplace plugin name must be remcp');
check(copilotMarketplace?.plugins?.[0]?.source === './', 'Copilot marketplace must source the root Agent Plugin');
check(copilotMarketplace?.plugins?.[0]?.version === version, 'Copilot marketplace plugin version must match package.json');

if (problems.length) {
  console.error('distribution check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`distribution contracts OK: Agent Plugins, Claude Code, Gemini CLI, MCP Registry, Copilot/VS Code (v${version})`);
