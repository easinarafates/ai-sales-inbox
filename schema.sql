-- AI সেলস ইনবক্স প্ল্যাটফর্ম — ডাটাবেস স্কিমা (PostgreSQL + pgvector)
-- উৎস: AI.pdf সেকশন ২ (টেক স্ট্যাক) ও সেকশন ৭ (ডাটাবেস টেবিল)
-- নিয়ম: প্রতিটি টেবিলে workspace_id আছে, প্রতিটি কোয়েরিতে এটি দিয়ে ফিল্টার করতে হবে।
-- AI মডেলের নাম কোডে হার্ডকোড নয়, কনফিগে থাকবে (এখন gemini-3.5-flash)।

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- workspaces: ব্যবসা, ব্যালেন্স, AI চালু/বন্ধ, প্র্যাকটিস মোড
CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  balance_paisa BIGINT NOT NULL DEFAULT 0,
  ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  practice_mode BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- users: লগইন
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- members: টিম সদস্য ও ভূমিকা
CREATE TABLE members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- channels: সংযুক্ত পেজ বা নম্বর, প্ল্যাটফর্ম, টোকেন (এনক্রিপ্টেড), স্ট্যাটাস
CREATE TABLE channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  platform TEXT NOT NULL, -- messenger | facebook_comment | instagram | webchat | whatsapp | tiktok
  external_id TEXT NOT NULL,
  display_name TEXT,
  token_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- customers: নাম, ফোন, ঠিকানা, চ্যানেল পরিচয়গুলো এক প্রোফাইলে জোড়া
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name TEXT,
  phone TEXT,
  address TEXT,
  channel_identities JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- conversations: চ্যাট, চ্যানেল, অ্যাসাইনি, অবস্থা, AI/মানুষ মোড
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  channel_id UUID REFERENCES channels(id),
  customer_id UUID REFERENCES customers(id),
  assignee_id UUID REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open', -- open | done | snoozed
  mode TEXT NOT NULL DEFAULT 'ai', -- ai | human
  snooze_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- messages: সব মেসেজ — দিক, টাইপ, প্ল্যাটফর্ম আইডি
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  direction TEXT NOT NULL, -- in | out
  type TEXT NOT NULL DEFAULT 'text', -- text | image | voice | card
  body TEXT,
  platform_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- comments: পোস্ট কমেন্ট, পোস্ট আইডি, উত্তর
CREATE TABLE comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  platform_post_id TEXT,
  platform_comment_id TEXT,
  body TEXT,
  replied BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- notes: টিম নোট
CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  conversation_id UUID REFERENCES conversations(id),
  customer_id UUID REFERENCES customers(id),
  author_id UUID REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- products: প্রোডাক্ট, দাম, সাইজ, স্টক
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name TEXT NOT NULL,
  price_paisa BIGINT NOT NULL,
  size TEXT,
  stock INT NOT NULL DEFAULT 0,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- product_images: ছবি ও এমবেডিং (pgvector)
CREATE TABLE product_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES products(id),
  url TEXT NOT NULL,
  embedding vector(768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- knowledge_items: নলেজ বুকের লেখা ও এমবেডিং
CREATE TABLE knowledge_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  embedding vector(768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- unanswered_questions: AI উত্তর দিতে না পারা প্রশ্ন ও গণনা
CREATE TABLE unanswered_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  question TEXT NOT NULL,
  count INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- orders: অর্ডার, উৎস, অর্ডার ধাপ, পেমেন্ট ধাপ, বিল
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  customer_id UUID REFERENCES customers(id),
  conversation_id UUID REFERENCES conversations(id),
  source TEXT, -- ai | product_page | team | website
  status TEXT NOT NULL DEFAULT 'pending', -- pending | on_hold | approved | processing | ready_to_ship | in_transit | delivered
  payment_status TEXT NOT NULL DEFAULT 'unpaid', -- unpaid | paid
  total_paisa BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- order_items
CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  order_id UUID NOT NULL REFERENCES orders(id),
  product_id UUID REFERENCES products(id),
  quantity INT NOT NULL DEFAULT 1,
  price_paisa BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- order_events: অর্ডারের প্রতিটি অবস্থা বদলের ইতিহাস
CREATE TABLE order_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  order_id UUID NOT NULL REFERENCES orders(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- coupons: কুপনের ধরন, মান, মেয়াদ
CREATE TABLE coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  code TEXT NOT NULL,
  type TEXT NOT NULL, -- percent | amount | free_delivery
  value BIGINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- shipments: কুরিয়ার, ট্র্যাকিং কোড, স্ট্যাটাস
CREATE TABLE shipments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  order_id UUID NOT NULL REFERENCES orders(id),
  courier TEXT,
  tracking_code TEXT,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- leads: আগ্রহী কাস্টমার, চাহিদা, ফলো-আপ সময়, ফলাফল
CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  customer_id UUID REFERENCES customers(id),
  need TEXT,
  follow_up_at TIMESTAMPTZ,
  outcome TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- followups: নির্ধারিত ফলো-আপ বার্তা ও অবস্থা
CREATE TABLE followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  lead_id UUID REFERENCES leads(id),
  message TEXT,
  send_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- tickets: সাপোর্ট টিকেট, কারণ, দায়িত্বশীল, অবস্থা
CREATE TABLE tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  conversation_id UUID REFERENCES conversations(id),
  customer_id UUID REFERENCES customers(id),
  reason TEXT,
  assignee_id UUID REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- scheduled_posts: পোস্টের ক্যাপশন, মিডিয়া, প্ল্যাটফর্ম, সময়, স্ট্যাটাস, প্ল্যাটফর্ম পোস্ট আইডি
CREATE TABLE scheduled_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  caption TEXT,
  media_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  platforms TEXT[] NOT NULL DEFAULT '{}',
  scheduled_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | scheduled | publishing | published | failed
  platform_post_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- post_products: পোস্টের সাথে জোড়া প্রোডাক্ট
CREATE TABLE post_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  scheduled_post_id UUID NOT NULL REFERENCES scheduled_posts(id),
  product_id UUID NOT NULL REFERENCES products(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ai_usage_ledger: প্রতিটি AI রিপ্লাইয়ের টোকেন ও পয়সায় খরচ
-- provider: কোন AI উত্তর দিয়েছে — 'gemini' | 'groq' (ফ্রি, ০ পয়সা) | 'demo' (লোকাল ডেমো মোড)
CREATE TABLE ai_usage_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  conversation_id UUID REFERENCES conversations(id),
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  cost_paisa BIGINT NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT 'gemini',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- wallet_transactions: ক্রেডিট যোগ ও কাটা
CREATE TABLE wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  type TEXT NOT NULL, -- topup | ai_charge | refund
  amount_paisa BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- webhook_events: আসা ওয়েবহুক (ডুপ্লিকেট আটকাতে)
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  platform TEXT NOT NULL,
  platform_event_id TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, platform, platform_event_id)
);

-- ইনডেক্স: workspace দিয়ে ফিল্টার + সার্চ
CREATE INDEX idx_conversations_workspace ON conversations(workspace_id, updated_at DESC);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX idx_orders_workspace ON orders(workspace_id, status);
CREATE INDEX idx_products_workspace ON products(workspace_id);
CREATE INDEX idx_customers_phone ON customers(workspace_id, phone);
