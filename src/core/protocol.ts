/**
 * Windows and the worker talk over postMessage and can come from different builds for a moment
 * after an update. A request from another protocol version is refused with a reload hint.
 */
export const protocolVersion = 1;

export type Op =
  | 'answer'
  | 'appApproval'
  | 'appCall'
  | 'archiveExport'
  | 'archiveImport'
  | 'attachmentPreview'
  | 'attachmentRemove'
  | 'attachmentStage'
  | 'automationCreate'
  | 'automationRemove'
  | 'automationStatus'
  | 'chatgpt'
  | 'connectionActivate'
  | 'connectionBegin'
  | 'connectionCanFinish'
  | 'connectionDisconnect'
  | 'connectionFinish'
  | 'connectionPrepare'
  | 'create'
  | 'customModel'
  | 'delete'
  | 'enable'
  | 'event'
  | 'export'
  | 'export-shared'
  | 'files'
  | 'import'
  | 'install'
  | 'memory'
  | 'memoryChange'
  | 'models'
  | 'notifications'
  | 'resolve'
  | 'resume'
  | 'setupState'
  | 'state'
  | 'stop'
  | 'submit'
  | 'tick'
  | 'trace'
  | 'update';

export const reloadHint = 'Kinetik was updated. Reload this window to continue.';
