import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const news = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/news' }),
  schema: z.object({
    date: z.date(),
    title: z.string(),
    link: z.string().url().optional(),
  }),
});

const projects = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
  schema: z.object({
    title: z.string(),
    role: z.string(),
    roleDetail: z.string().optional(),
    status: z.enum(['ongoing', 'completed', 'upcoming']),
    startDate: z.date(),
    endDate: z.date(),
    budget: z.string().optional(),
    funder: z.string().optional(),
    funderRef: z.string().optional(),
    partners: z.array(z.string()).optional(),
    url: z.string().url().optional(),
    logo: z.string().optional(),
    featured: z.boolean().default(false),
    order: z.number().default(0),
  }),
});

const publications = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/publications' }),
  schema: z.object({
    title: z.string(),
    authors: z.string(),
    venue: z.string(),
    year: z.number(),
    type: z.enum(['journal', 'conference', 'book', 'chapter', 'preprint']).default('journal'),
    doi: z.string().optional(),
    url: z.string().url().optional(),
    pdf: z.string().optional(),
    scholar: z.string().url().optional(),
    bibtex: z.string().optional(),
    selected: z.boolean().default(false),
    order: z.number().default(0),
  }),
});

export const collections = { news, projects, publications };
