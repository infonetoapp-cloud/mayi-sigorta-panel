export const DOCUMENT_ROUTE_CONTRACT = Object.freeze([
  { path: '/api/documents', secure: false, operation: 'UPLOAD' },
  { path: '/api/documents/:id/download', secure: false, operation: 'DOWNLOAD' },
  { path: '/secure/api/documents/:id/download', secure: true, operation: 'DOWNLOAD' },
  { path: '/secure/api/documents/:id/download-grants', secure: true, operation: 'GRANT' },
  {
    path: '/secure/api/documents/:id/download-confirmation',
    secure: true,
    operation: 'CONFIRMATION',
  },
] as const);
