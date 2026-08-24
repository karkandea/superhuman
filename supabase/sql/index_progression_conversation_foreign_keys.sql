create index if not exists progression_messages_user_id_idx
  on public.progression_messages(user_id, created_at desc);

create index if not exists progression_research_user_id_idx
  on public.progression_research(user_id, completed_at desc);

create index if not exists progression_questions_answer_knowledge_entry_id_idx
  on public.progression_questions(answer_knowledge_entry_id);

create index if not exists progression_sessions_current_job_id_idx
  on public.progression_sessions(current_job_id);
