import { fileToolHandlers } from './tools/files.mjs';
import { searchToolHandlers } from './tools/search.mjs';
import { terminalToolHandlers } from './tools/terminal.mjs';
import { systemToolHandlers } from './tools/system.mjs';
import { statsToolHandlers } from './tools/stats.mjs';

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const readOnlyNonIdempotent = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const additive = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutating = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const command = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export const toolDefinitions = [
  {
    name: 'read_file',
    title: 'Read file',
    description: 'Read a text file on this computer. Use offset and length to page through large files; a negative offset reads from the end of the file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to read. Relative paths resolve against the runtime working directory.' },
        offset: { type: 'number', description: 'Zero-based first line to read. Negative values read the last N lines.' },
        length: { type: 'number', description: 'Maximum number of lines to return.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: fileToolHandlers.read_file,
  },
  {
    name: 'read_multiple_files',
    title: 'Read multiple files',
    description: 'Read several text files in one call. Each file is returned separately and a failure to read one file does not stop the others.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the files to read, at most 50 per call.' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: fileToolHandlers.read_multiple_files,
  },
  {
    name: 'read_image',
    title: 'Read image',
    description: 'Return an image file (PNG, JPEG, GIF, WebP, BMP, AVIF, or SVG) as a viewable image, so screenshots and diagrams can be inspected. Fails above the inline size limit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the image file.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: fileToolHandlers.read_image,
  },
  {
    name: 'hash_file',
    title: 'Hash file',
    description: 'Compute a checksum of a file without reading it into memory. Useful to verify a copy, compare two files, or confirm a download.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to hash.' },
        algorithm: { type: 'string', enum: ['sha256', 'sha1', 'md5'], description: 'Hash algorithm. Default sha256.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: fileToolHandlers.hash_file,
  },
  {
    name: 'list_directory',
    title: 'List directory',
    description: 'List the files and directories at a path. Entries are prefixed with [DIR], [FILE], [LINK], or [DENIED] when a subdirectory cannot be read. depth controls how many directory levels are included and pattern filters file names by glob.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the directory to list.' },
        depth: { type: 'number', description: 'Directory levels to list, from 1 to 5. Default 1.' },
        pattern: { type: 'string', description: 'Optional glob that filters file names, such as "*.log". Directories are always listed.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: fileToolHandlers.list_directory,
  },
  {
    name: 'get_file_info',
    title: 'Get file info',
    description: 'Return metadata for a file or directory: type, size, timestamps, permissions, and for small text files the line count.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to inspect.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: fileToolHandlers.get_file_info,
  },
  {
    name: 'write_file',
    title: 'Write file',
    description: 'Create a file or change its full content. Parent directories are created automatically. Replacing a file that already has content requires an explicit mode, so an existing file cannot be destroyed by accident: use mode "rewrite" to replace it or "append" to add to the end.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to write.' },
        content: { type: 'string', description: 'Full file content, or the text to append.' },
        mode: { type: 'string', enum: ['rewrite', 'append'], description: 'rewrite replaces the file content, append adds to the end. Required when the file already contains data.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    annotations: mutating,
    handler: fileToolHandlers.write_file,
  },
  {
    name: 'edit_block',
    title: 'Edit file',
    description: 'Replace an exact block of text in a file. Provide enough surrounding context to make old_string unique; the call fails unless the number of matches equals expected_replacements. When the exact text is not found, a whitespace-tolerant match is attempted and reported. Pass dry_run to preview the change as a diff without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path of the file to edit.' },
        old_string: { type: 'string', description: 'Exact existing text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        expected_replacements: { type: 'number', description: 'Number of matches required for the edit to apply. Default 1.' },
        allow_fuzzy: { type: 'boolean', description: 'Allow a whitespace-tolerant fallback when the exact text is not found. Default true.' },
        dry_run: { type: 'boolean', description: 'Return the diff without changing the file. Default false.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    annotations: mutating,
    handler: fileToolHandlers.edit_block,
  },
  {
    name: 'replace_lines',
    title: 'Replace lines',
    description: 'Replace an inclusive 1-based line range with new text. The rest of the file, including its line endings, is preserved. Pass dry_run to preview the change as a diff without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to edit.' },
        start_line: { type: 'number', description: 'First line to replace, 1-based and inclusive.' },
        end_line: { type: 'number', description: 'Last line to replace, 1-based and inclusive.' },
        content: { type: 'string', description: 'Replacement text; an empty string deletes the range.' },
        dry_run: { type: 'boolean', description: 'Return the diff without changing the file. Default false.' },
      },
      required: ['path', 'start_line', 'end_line', 'content'],
      additionalProperties: false,
    },
    annotations: mutating,
    handler: fileToolHandlers.replace_lines,
  },
  {
    name: 'replace_in_files',
    title: 'Replace in files',
    description: 'Replace text or a regular expression across the text files under a path and report what changed. Defaults to a dry run that only lists the affected files; pass dry_run false to write the changes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of a file or directory to search.' },
        pattern: { type: 'string', description: 'Text or regular expression to find.' },
        replacement: { type: 'string', description: 'Replacement text. In regex mode, $1 and friends refer to capture groups.' },
        filePattern: { type: 'string', description: 'Optional glob limiting which file names are changed, such as "*.ts".' },
        regex: { type: 'boolean', description: 'Treat pattern as a regular expression. Default false (plain text).' },
        dry_run: { type: 'boolean', description: 'Only report the files that would change. Default true.' },
        maxFiles: { type: 'number', description: 'Stop after this many changed files. Default 100, maximum 500.' },
      },
      required: ['path', 'pattern', 'replacement'],
      additionalProperties: false,
    },
    annotations: mutating,
    handler: fileToolHandlers.replace_in_files,
  },
  {
    name: 'diff_files',
    title: 'Diff files',
    description: 'Show a unified diff between two local text files, with line counts. Useful to check what changed before reporting or reverting it.',
    inputSchema: {
      type: 'object',
      properties: {
        left: { type: 'string', description: 'Absolute path of the original file.' },
        right: { type: 'string', description: 'Absolute path of the file to compare against it.' },
        context_lines: { type: 'number', description: 'Lines of context around each change. Default 3, maximum 20.' },
      },
      required: ['left', 'right'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: fileToolHandlers.diff_files,
  },
  {
    name: 'move_to_trash',
    title: 'Move to trash',
    description: 'Move a file or directory to the system trash instead of deleting it, so the change can be undone. When the trash is outside the device allowed roots, a .remcp-trash folder beside the file is used instead.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute path to move to the trash.' },
      },
      required: ['source'],
      additionalProperties: false,
    },
    annotations: additive,
    handler: fileToolHandlers.move_to_trash,
  },
  {
    name: 'create_directory',
    title: 'Create directory',
    description: 'Create a directory, including any missing parent directories. Succeeds when the directory already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the directory to create.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: additive,
    handler: fileToolHandlers.create_directory,
  },
  {
    name: 'move_file',
    title: 'Move or rename',
    description: 'Move or rename a file or directory. The call fails when the destination already exists, so nothing is overwritten.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute path to move.' },
        destination: { type: 'string', description: 'Absolute destination path.' },
      },
      required: ['source', 'destination'],
      additionalProperties: false,
    },
    annotations: additive,
    handler: fileToolHandlers.move_file,
  },
  {
    name: 'copy_file',
    title: 'Copy file',
    description: 'Copy one file to a new path. The call fails when the destination exists unless overwrite is true. Directories are not copied recursively.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute path of the file to copy.' },
        destination: { type: 'string', description: 'Absolute destination path.' },
        overwrite: { type: 'boolean', description: 'Replace the destination when it already exists. Default false.' },
      },
      required: ['source', 'destination'],
      additionalProperties: false,
    },
    annotations: additive,
    handler: fileToolHandlers.copy_file,
  },
  {
    name: 'start_search',
    title: 'Start search',
    description: 'Start a filename or content search on this computer and return the first results. Content searches return "path:line: text" rows. Use get_more_search_results to page and stop_search to stop a long search.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the directory or file to search.' },
        pattern: { type: 'string', description: 'Regular expression for content searches, or a glob such as "*.ts" when searchType is files.' },
        searchType: { type: 'string', enum: ['content', 'files'], description: 'Search file contents (default) or file names.' },
        filePattern: { type: 'string', description: 'Optional relative glob that limits which files are searched, such as "*.ts".' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive content matching.' },
        maxResults: { type: 'number', description: 'Stop the search after this many results. Default 200.' },
        includeHidden: { type: 'boolean', description: 'Include hidden files and directories.' },
        includeIgnored: { type: 'boolean', description: 'Also search directories normally skipped, such as node_modules, dist, build, and virtualenvs.' },
        contextLines: { type: 'number', description: 'Number of context lines to return around each content match, up to 10.' },
        literalSearch: { type: 'boolean', description: 'Treat the pattern as literal text instead of a regular expression.' },
      },
      required: ['path', 'pattern'],
      additionalProperties: false,
    },
    annotations: readOnlyNonIdempotent,
    handler: searchToolHandlers.start_search,
  },
  {
    name: 'get_more_search_results',
    title: 'Get more search results',
    description: 'Read more results from a search started with start_search. Offset is zero-based; a negative offset returns the last N results.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Search id returned by start_search.' },
        offset: { type: 'number', description: 'Zero-based first result to return. Negative values read from the end.' },
        length: { type: 'number', description: 'Maximum number of results to return. Default 100.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: searchToolHandlers.get_more_search_results,
  },
  {
    name: 'stop_search',
    title: 'Stop search',
    description: 'Stop a running search. Results collected so far stay readable until the search is cleaned up.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Search id returned by start_search.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    annotations: additive,
    handler: searchToolHandlers.stop_search,
  },
  {
    name: 'list_searches',
    title: 'List searches',
    description: 'List active and recent searches on this computer with their status and result counts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    handler: searchToolHandlers.list_searches,
  },
  {
    name: 'start_process',
    title: 'Start process',
    description: 'Run a shell command on this computer and return its initial output. The process keeps running so read_process_output or interact_with_process can be used later. Commands can change local or external state.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        timeout_ms: { type: 'number', description: 'How long to wait for initial output before returning, in milliseconds. Default 1000.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    annotations: command,
    handler: terminalToolHandlers.start_process,
  },
  {
    name: 'read_process_output',
    title: 'Read process output',
    description: 'Read buffered output from a session started with start_process. Without an offset it returns output produced since the previous read.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Session pid returned by start_process.' },
        offset: { type: 'number', description: 'Zero-based line number to start from, counted across everything the session has produced; a negative value reads the last N lines. Omit for new output. Lines evicted by the buffer cap are no longer available.' },
        length: { type: 'number', description: 'Maximum number of lines to return.' },
        timeout_ms: { type: 'number', description: 'How long to wait for new output when no offset is given, in milliseconds.' },
      },
      required: ['pid'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: terminalToolHandlers.read_process_output,
  },
  {
    name: 'interact_with_process',
    title: 'Interact with process',
    description: 'Send one line of input to a running session and return the output it produces. Use this for REPLs and other interactive commands.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Session pid returned by start_process.' },
        input: { type: 'string', description: 'Line of input to send; a newline is appended.' },
        timeout_ms: { type: 'number', description: 'How long to wait for the response, in milliseconds. Default 1000.' },
      },
      required: ['pid', 'input'],
      additionalProperties: false,
    },
    annotations: command,
    handler: terminalToolHandlers.interact_with_process,
  },
  {
    name: 'wait_for_process_output',
    title: 'Wait for process output',
    description: 'Wait until output from a running session matches a regular expression or literal string, then return the output collected since the previous read. Use this instead of polling read_process_output in a loop.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Session pid returned by start_process.' },
        pattern: { type: 'string', description: 'Regular expression or literal text to wait for.' },
        timeout_ms: { type: 'number', description: 'How long to wait before returning the output collected so far, in milliseconds. Default 10000.' },
      },
      required: ['pid', 'pattern'],
      additionalProperties: false,
    },
    annotations: readOnlyNonIdempotent,
    handler: terminalToolHandlers.wait_for_process_output,
  },
  {
    name: 'force_terminate',
    title: 'Stop session',
    description: 'Stop a session started with start_process, escalating from SIGTERM to SIGKILL when it does not exit.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Session pid returned by start_process.' },
      },
      required: ['pid'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: terminalToolHandlers.force_terminate,
  },
  {
    name: 'list_sessions',
    title: 'List sessions',
    description: 'List terminal sessions started during this ReMCP runtime session with their status and how long they have been running.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    handler: terminalToolHandlers.list_sessions,
  },
  {
    name: 'get_system_info',
    title: 'Get system info',
    description: 'Report host details for the paired computer: operating system and kernel, CPU model and load, memory pressure, free disk space on the working volume, uptime, and the default shell.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    handler: systemToolHandlers.get_system_info,
  },
  {
    name: 'list_processes',
    title: 'List processes',
    description: 'List running operating-system processes on this computer, highest CPU first, with pid, parent pid, CPU and memory usage, and command. Values that look like secrets are masked.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of processes to return. Default 100, maximum 1000.' },
      },
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: systemToolHandlers.list_processes,
  },
  {
    name: 'kill_process',
    title: 'Kill process',
    description: 'Terminate an operating-system process by pid. Terminates the process and its children on Windows.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Process id to terminate.' },
      },
      required: ['pid'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: systemToolHandlers.kill_process,
  },
  {
    name: 'get_runtime_info',
    title: 'Get runtime info',
    description: 'Report this device runtime: version, configuration, allowed roots, command policy, output limits, and whether usage metrics are enabled. Read-only; configuration cannot be changed through MCP.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    handler: statsToolHandlers.get_runtime_info,
  },
  {
    name: 'get_runtime_stats',
    title: 'Get runtime stats',
    description: 'Report local counters for this runtime session: tool calls and failures, blocked commands, active terminal and search sessions, and usage-metric queue state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    handler: statsToolHandlers.get_runtime_stats,
  },
];

export const toolHandlers = new Map(toolDefinitions.map(definition => [definition.name, definition]));
