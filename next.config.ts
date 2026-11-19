import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The embedding model runs natively in Node (onnxruntime); keep these packages out of the bundle.
  serverExternalPackages: ['@huggingface/transformers', 'onnxruntime-node', 'sharp'],
  experimental: {
    serverActions: { bodySizeLimit: '6mb' },   // portfolio photo uploads (max 5 MB each)
  },
};

export default nextConfig;
