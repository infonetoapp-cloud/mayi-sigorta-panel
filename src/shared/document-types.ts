export interface EmployeeDocumentDto {
  readonly documentId: string;
  readonly fileName: string;
  readonly classification: 'GENERAL' | 'IDENTITY' | 'HEALTH';
  readonly status: 'PROCESSING' | 'READY' | 'FAILED';
  readonly createdAt: string;
  readonly sizeBytes: number;
  readonly downloadMode: 'NORMAL' | 'SENSITIVE';
}
export interface EmployeeDocumentPage {
  readonly documents: EmployeeDocumentDto[];
  readonly nextCursor: string | null;
}
