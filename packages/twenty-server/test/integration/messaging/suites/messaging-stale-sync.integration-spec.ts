import {
  ConnectedAccountProvider,
  MessageChannelSyncStage,
} from 'twenty-shared/types';

import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { MessagingOngoingStaleCronJob } from 'src/modules/messaging/message-import-manager/crons/jobs/messaging-ongoing-stale.cron.job';
import { connectMessagingAccount } from 'test/integration/messaging/utils/connect-messaging-account.util';
import {
  googleAccountIdentityHandlers,
  setupGmailMock,
} from 'test/integration/messaging/utils/gmail-mock.util';
import { queryMessageChannel } from 'test/integration/messaging/utils/query-messaging.util';
import { enqueueJob } from 'test/integration/utils/enqueue-job.util';
import { getCoreRepository } from 'test/integration/utils/get-core-repository.util';
import { pollUntil } from 'test/integration/utils/poll-until.util';

const STALE_HANDLE = 'messaging-stale-sync@apple.dev';
const RECENT_HANDLE = 'messaging-recent-sync@apple.dev';

const STALE_STARTED_AT = new Date(Date.now() - 31 * 60 * 1000);
const RECENT_STARTED_AT = new Date(Date.now() - 60 * 1000);

// A crashed worker leaves a channel stuck in an ongoing stage; that crash cannot be
// reproduced through public surfaces (a hung job would deadlock the single-concurrency
// messaging worker), so the stuck state is written onto OAuth-created channels directly.
const simulateCrashedSync = (messageChannelId: string, startedAt: Date) =>
  getCoreRepository<MessageChannelEntity>(MessageChannelEntity).update(
    { id: messageChannelId },
    {
      syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_ONGOING,
      syncStageStartedAt: startedAt,
    },
  );

describe('Messaging stale-sync recovery (integration)', () => {
  const gmail = setupGmailMock({ inbox: [], handle: STALE_HANDLE });

  let staleChannel: Awaited<ReturnType<typeof connectMessagingAccount>>;
  let recentChannel: Awaited<ReturnType<typeof connectMessagingAccount>>;

  beforeAll(async () => {
    staleChannel = await connectMessagingAccount({
      provider: ConnectedAccountProvider.GOOGLE,
      handle: STALE_HANDLE,
    });

    gmail.use(...googleAccountIdentityHandlers(RECENT_HANDLE));

    recentChannel = await connectMessagingAccount({
      provider: ConnectedAccountProvider.GOOGLE,
      handle: RECENT_HANDLE,
    });

    for (const connectedChannel of [staleChannel, recentChannel]) {
      await pollUntil(
        () =>
          queryMessageChannel(
            connectedChannel.connectedAccountId,
            connectedChannel.channelId,
          ),
        (channelState) =>
          channelState.syncStage ===
          MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
      );
    }
  }, 120000);

  afterAll(async () => {
    await staleChannel.cleanup();
    await recentChannel.cleanup();
  });

  it('resets a stale ongoing channel to pending and leaves a recent one running', async () => {
    await simulateCrashedSync(staleChannel.channelId, STALE_STARTED_AT);
    await simulateCrashedSync(recentChannel.channelId, RECENT_STARTED_AT);

    await enqueueJob(MessageQueue.cronQueue, MessagingOngoingStaleCronJob, {});

    const staleChannelAfter = await pollUntil(
      () =>
        queryMessageChannel(
          staleChannel.connectedAccountId,
          staleChannel.channelId,
        ),
      (channelState) =>
        channelState.syncStage ===
        MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
    );

    expect(staleChannelAfter.syncStage).toBe(
      MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
    );
    expect(staleChannelAfter.syncStageStartedAt).toBeNull();

    const recentChannelAfter = await queryMessageChannel(
      recentChannel.connectedAccountId,
      recentChannel.channelId,
    );

    expect(recentChannelAfter.syncStage).toBe(
      MessageChannelSyncStage.MESSAGE_LIST_FETCH_ONGOING,
    );
  }, 60000);
});
