create index if not exists player_initialization_answer_knowledge_idx
  on public.player_initialization_questions(answer_knowledge_entry_id)
  where answer_knowledge_entry_id is not null;
