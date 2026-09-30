-- Phase 4.19: real-data messages + the notification side effects the
-- frontend could never produce itself (notifications has no INSERT policy
-- for any role — confirmed live and documented since Phase 4.13/4.15).
--
-- Two events, one trigger, same SECURITY DEFINER pattern
-- approve_registration_request() already uses to write a notification on
-- someone else's behalf:
--   1. A displaced person files a new message -> every camp_admin of that
--      camp (who has not opted out via user_preferences.notify_messages)
--      is notified.
--   2. An admin sets/edits a reply -> the original sender is notified.

create or replace function private.handle_message_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.notifications (recipient_id, type, title, body, href)
    select
      p.id,
      'info',
      'رسالة جديدة من نازح',
      coalesce((select full_name from public.profiles where id = new.sender_id), 'أحد النازحين')
        || ' أرسل رسالة جديدة.',
      'message-details.html?id=' || new.id
    from public.profiles p
    left join public.user_preferences up on up.user_id = p.id
    where p.role = 'camp_admin'
      and p.camp_id = new.camp_id
      and coalesce(up.notify_messages, true);

  elsif tg_op = 'UPDATE' and new.reply is not null and new.reply is distinct from old.reply then
    insert into public.notifications (recipient_id, type, title, body, href)
    values (
      new.sender_id,
      'info',
      'رد جديد من إدارة المخيم',
      'تم الرد على رسالتك.',
      'message-details.html?id=' || new.id
    );
  end if;

  return new;
end;
$$;

create trigger messages_notify_on_change
  after insert or update on public.messages
  for each row execute function private.handle_message_change();
