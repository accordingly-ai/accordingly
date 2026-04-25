import type { ChatCompletionTool } from './tools';

export const DRIVE_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_drive_files',
      description:
        'List the Google Drive files the user has explicitly connected to this app. Returns id, name, and mimeType for each file. Use this to discover what documents you can read.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_drive_file',
      description:
        'Read the text contents of a connected Google Drive file by id. Works for Google Docs/Sheets, plain text/markdown, PDFs (including scanned), and images (OCR). Returns { name, mimeType, text }. Long documents are truncated.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The Drive file id from list_drive_files.' },
        },
        required: ['id'],
      },
    },
  },
];
