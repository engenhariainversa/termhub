import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { requestChatJump } from '../../lib/chat-jump';
import { showConciergeNotice, subscribeConciergeNotices } from '../../lib/concierge-notice';
import { useProjectChat } from '../../lib/project-chat';

/**
 * TER-1101: shows the concierge's notices as browser notifications (when the person allowed them), unless
 * they are looking at that chat right now. A click opens that chat — the project's dock, or /chat for the
 * account-wide one — at the message. Renders nothing.
 */
export function ConciergeNotices() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { shownProjectId, setOpen } = useProjectChat();
  const live = useRef({ navigate, pathname, shownProjectId, setOpen });
  live.current = { navigate, pathname, shownProjectId, setOpen };

  useEffect(
    () =>
      subscribeConciergeNotices((e) => {
        const now = live.current;
        showConciergeNotice(e, {
          chatOnScreen: e.project_id ? now.shownProjectId === e.project_id : now.pathname === '/chat',
          onOpen: () => {
            const { navigate: go, setOpen: open } = live.current;
            if (e.project_id) {
              open(e.project_id, true);
              go(`/projects/${e.project_id}`);
            } else go('/chat');
            if (e.message_id) requestChatJump({ conversationId: e.conversation_id, messageId: e.message_id });
          },
        });
      }),
    [],
  );
  return null;
}
