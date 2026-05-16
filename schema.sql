-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Users
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE,
    telegram_id BIGINT UNIQUE, -- Map Telegram users
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Profiles
CREATE TABLE IF NOT EXISTS public.profiles (
    user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    skills TEXT[],
    interests TEXT[],
    tracked_companies TEXT[],
    batch_year INT,
    cgpa DECIMAL(3,2),
    domain_preferences TEXT[],
    profile_embedding VECTOR(1536),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Opportunities
CREATE TABLE IF NOT EXISTS public.opportunities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    description TEXT,
    url TEXT UNIQUE NOT NULL,
    source TEXT NOT NULL,
    deadline TIMESTAMP WITH TIME ZONE,
    eligibility_criteria JSONB,
    tags TEXT[],
    opportunity_embedding VECTOR(1536),
    content_hash TEXT UNIQUE,
    sources TEXT[],
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User-Opportunity Relevance
CREATE TABLE IF NOT EXISTS public.user_opportunity_relevance (
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    opportunity_id UUID REFERENCES public.opportunities(id) ON DELETE CASCADE,
    relevance_score FLOAT,
    status TEXT DEFAULT 'pending',
    PRIMARY KEY (user_id, opportunity_id)
);

-- Gmail Tokens
CREATE TABLE IF NOT EXISTS public.gmail_tokens (
    user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    access_token TEXT,
    refresh_token TEXT,
    expires_at TIMESTAMP WITH TIME ZONE
);

-- Scraper Runs
CREATE TABLE IF NOT EXISTS public.scrape_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    items_found INT DEFAULT 0,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Potential Duplicates
CREATE TABLE IF NOT EXISTS public.potential_duplicates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_id UUID REFERENCES public.opportunities(id) ON DELETE CASCADE,
    duplicate_id UUID REFERENCES public.opportunities(id) ON DELETE CASCADE,
    distance FLOAT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Subscriptions
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    stripe_customer_id TEXT UNIQUE,
    stripe_subscription_id TEXT UNIQUE,
    tier TEXT NOT NULL,
    status TEXT NOT NULL,
    current_period_end TIMESTAMP WITH TIME ZONE
);

-- Create HNSW Index
CREATE INDEX IF NOT EXISTS opportunities_hnsw_idx ON public.opportunities USING hnsw (opportunity_embedding vector_cosine_ops);
