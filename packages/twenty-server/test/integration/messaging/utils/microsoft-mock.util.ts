import { randomUUID } from 'node:crypto';

import {
  type MailFolder,
  type Message,
} from '@microsoft/microsoft-graph-types';
import { http, HttpResponse, type RequestHandler } from 'msw';

import { type HttpMock, setupHttpMock } from 'test/integration/utils/http-mock';

export const microsoftMessage = (overrides: Partial<Message> = {}): Message => {
  const id = overrides.id ?? `ms-msg-${randomUUID()}`;

  return {
    id,
    subject: `Subject ${id}`,
    internetMessageId: `<${id}@example.com>`,
    receivedDateTime: '2023-11-15T00:00:00Z',
    from: { emailAddress: { address: 'sender@example.com' } },
    toRecipients: [{ emailAddress: { address: 'recipient@example.com' } }],
    ccRecipients: [],
    bccRecipients: [],
    body: { contentType: 'text', content: `body ${id}` },
    ...overrides,
  };
};

export const getMicrosoftMessageSubject = (message: Message): string =>
  message.subject ?? '';

const DEFAULT_FOLDERS: MailFolder[] = [
  { id: 'inbox', displayName: 'Inbox' },
  { id: 'sentitems', displayName: 'Sent Items' },
];

export type MicrosoftFolderStore = {
  add: (folder: MailFolder) => void;
  remove: (folderId: string) => void;
  reset: () => void;
  list: () => MailFolder[];
};

const createMicrosoftFolderStore = (
  initialFolders: MailFolder[],
): MicrosoftFolderStore => {
  let folders = [...initialFolders];

  return {
    add: (folder) => {
      folders = [...folders, folder];
    },
    remove: (folderId) => {
      folders = folders.filter((folder) => folder.id !== folderId);
    },
    reset: () => {
      folders = [...initialFolders];
    },
    list: () => folders,
  };
};

const microsoftHandlers = ({
  inbox,
  folderStore,
  handle,
}: {
  inbox: Message[];
  folderStore: MicrosoftFolderStore;
  handle: string;
}): RequestHandler[] => [
  http.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', () =>
    HttpResponse.json({
      token_type: 'Bearer',
      access_token: 'mock-access-token',
      refresh_token: 'mock-refresh-token',
      expires_in: 3600,
      scope: 'openid profile email offline_access',
    }),
  ),
  http.get('https://graph.microsoft.com/v1.0/me', () =>
    HttpResponse.json({
      id: 'microsoft-user-id',
      displayName: 'Jane Austen',
      givenName: 'Jane',
      surname: 'Austen',
      mail: handle,
      userPrincipalName: handle,
    }),
  ),
  http.get('*/me/mailFolders', () =>
    HttpResponse.json<{ value: MailFolder[] }>({ value: folderStore.list() }),
  ),
  http.get('*/messages/delta', () =>
    HttpResponse.json<{ value: Message[]; '@odata.deltaLink': string }>({
      value: inbox.map((message) => ({ id: message.id })),
      '@odata.deltaLink':
        'https://graph.microsoft.com/beta/me/mailfolders/inbox/messages/delta?$deltatoken=mock-delta-token',
    }),
  ),
  http.post('*/$batch', () =>
    HttpResponse.json<{
      responses: { id: string; status: number; body: Message }[];
    }>({
      responses: inbox.map((message, index) => ({
        id: (index + 1).toString(),
        status: 200,
        body: message,
      })),
    }),
  ),
];

export const setupMicrosoftMock = ({
  inbox,
  folders = DEFAULT_FOLDERS,
  handle = 'me@example.com',
}: {
  inbox: Message[];
  folders?: MailFolder[];
  handle?: string;
}): {
  folders: MicrosoftFolderStore;
  use: HttpMock['use'];
} => {
  const folderStore = createMicrosoftFolderStore(folders);

  const httpMock = setupHttpMock(
    ...microsoftHandlers({ inbox, folderStore, handle }),
  );

  return { folders: folderStore, use: httpMock.use };
};
