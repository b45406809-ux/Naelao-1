/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  transpilePackages: ['@naelao/ui', '@naelao/types', '@naelao/billing-core'],
};

export default nextConfig;

