export type Language = "en" | "zh";

export type LocalizedText = {
  en: string;
  zh: string;
};

export type PublicationLink = {
  label: string;
  href: string;
};

export type Author = {
  name: string;
  mark?: string;
};

export type Publication = {
  slug: string;
  title: string;
  authors: Author[];
  venue: string;
  year: number;
  description: LocalizedText;
  links: PublicationLink[];
  selected?: boolean;
  image?: string;
  imageAlt?: LocalizedText;
  note?: LocalizedText;
};

export const profileLinks = [
  { label: "Email", href: "mailto:ZhengHanYou@outlook.com" },
  {
    label: "Google Scholar",
    href: "https://scholar.google.com/citations?user=jkmAz5kAAAAJ",
  },
  { label: "GitHub", href: "https://github.com/zzzhy03" },
] as const;

export const news = [
  {
    date: { en: "Aug 2026", zh: "2026 年 8 月" },
    text: {
      en: "I launched my personal homepage.",
      zh: "创建了我的个人主页。",
    },
  },
] as const;

export const publications: Publication[] = [
  {
    slug: "lego-maker",
    title: "LEGO®-Maker: Autoregressive Image-Conditioned LEGO® Model Creation",
    authors: [
      { name: "Jiahao Ge", mark: "*" },
      { name: "Mingjun Zhou", mark: "*" },
      { name: "Hanyou Zheng" },
      { name: "Hao Xu", mark: "†" },
      { name: "Chi-Wing Fu", mark: "†" },
    ],
    venue: "ACM Transactions on Graphics (Proceedings of SIGGRAPH Asia 2025), 44(6)",
    year: 2025,
    description: {
      en: "Built an image-conditioned autoregressive framework that uses LEGO tokenization to generate collision-free LEGO models from reference images with over 100 brick types.",
      zh: "构建图像条件自回归框架，通过积木 tokenization 方法从参考图像生成涵盖 100 余种积木类型的无碰撞 LEGO 模型。",
    },
    links: [
      { label: "Project", href: "https://occulte.github.io/publication/LEGO-Maker" },
      { label: "DOI", href: "https://doi.org/10.1145/3763285" },
      { label: "Video", href: "https://youtu.be/66Cy7VPgASg" },
    ],
    selected: true,
    image: "/research/lego-maker.png",
    imageAlt: {
      en: "LEGO models of colorful building facades generated from reference images",
      zh: "由参考图像生成的彩色建筑立面 LEGO 模型",
    },
    note: {
      en: "* Equal contribution. † Corresponding authors.",
      zh: "* 表示共同第一作者；† 表示通讯作者。",
    },
  },
  {
    slug: "stno",
    title: "Space-Time Video Super-Resolution With Neural Operator",
    authors: [
      { name: "Yuantong Zhang" },
      { name: "Hanyou Zheng" },
      { name: "Daiqin Yang" },
      { name: "Zhenzhong Chen" },
      { name: "Haichuan Ma" },
      { name: "Wenpeng Ding" },
    ],
    venue: "IEEE Transactions on Image Processing, 34:6742-6754",
    year: 2025,
    description: {
      en: "Developed a neural-operator method for space-time video super-resolution that models motion estimation and compensation as a mapping between continuous function spaces, and uses Galerkin-type attention to handle large motions with global receptive fields and linear complexity.",
      zh: "开发基于神经算子的时空视频超分辨率方法，将运动估计与补偿建模为连续函数空间之间的映射，并利用 Galerkin 型注意力以全局感受野和线性复杂度处理大幅度运动。",
    },
    links: [
      { label: "DOI", href: "https://doi.org/10.1109/TIP.2025.3616609" },
      { label: "arXiv", href: "https://arxiv.org/abs/2404.06036" },
      { label: "Code", href: "https://github.com/hahazh/STVSR-NO" },
    ],
    selected: true,
    image: "/research/stno.png",
    imageAlt: {
      en: "A restored video frame showing a traditional street scene",
      zh: "经过恢复的传统街景视频帧",
    },
  },
  {
    slug: "ntire-2024-raim",
    title: "NTIRE 2024 Restore Any Image Model (RAIM) in the Wild Challenge",
    authors: [
      { name: "Jie Liang" },
      { name: "Radu Timofte" },
      { name: "..." },
      { name: "Hanyou Zheng" },
      { name: "et al." },
    ],
    venue: "CVPR Workshops, pp. 6632-6640",
    year: 2024,
    description: {
      en: "Developed DAIR, a degradation-aware image-restoration framework that models complex unknown degradations through per-pixel degradation-kernel estimation and representation injection, and uses generative priors to enhance texture details; ranked 2nd by objective score and 4th overall, receiving a Third-Class Award.",
      zh: "开发退化感知图像恢复框架 DAIR，通过逐像素退化核估计与退化表征注入建模复杂未知退化，并利用生成式先验增强纹理细节；客观指标排名第 2、综合排名第 4，并获三等奖。",
    },
    links: [
      {
        label: "Paper",
        href: "https://openaccess.thecvf.com/content/CVPR2024W/NTIRE/html/Liang_NTIRE_2024_Restore_Any_Image_Model_RAIM_in_the_Wild_CVPRW_2024_paper.html",
      },
    ],
  },
  {
    slug: "ntire-2023-esr",
    title: "NTIRE 2023 Challenge on Efficient Super-Resolution: Methods and Results",
    authors: [
      { name: "Yawei Li" },
      { name: "Yulun Zhang" },
      { name: "..." },
      { name: "Hanyou Zheng" },
      { name: "et al." },
    ],
    venue: "CVPR Workshops, pp. 1922-1960",
    year: 2023,
    description: {
      en: "Proposed Diversified Local Feature Arch-Network for efficient image super-resolution under reconstruction-quality, model-complexity, and computational-cost constraints.",
      zh: "提出 Diversified Local Feature Arch-Network 模块，在图像重建质量、模型复杂度与计算成本约束下探索高效图像超分辨率。",
    },
    links: [
      {
        label: "Paper",
        href: "https://openaccess.thecvf.com/content/CVPR2023W/NTIRE/html/Li_NTIRE_2023_Challenge_on_Efficient_Super-Resolution_Methods_and_Results_CVPRW_2023_paper.html",
      },
    ],
  },
];

export const honors = [
  {
    year: "2023",
    event: {
      en: "ICPC Asia Regional Contest (Shenyang)",
      zh: "ICPC 国际大学生程序设计竞赛亚洲区域赛（沈阳站）",
    },
    award: { en: "Gold Medal", zh: "金奖" },
  },
  {
    year: "2023",
    event: {
      en: "ICPC Asia Regional Contest (Xi'an)",
      zh: "ICPC 国际大学生程序设计竞赛亚洲区域赛（西安站）",
    },
    award: { en: "Gold Medal", zh: "金奖" },
  },
  {
    year: "2024",
    event: {
      en: "ICPC East Asia Continent Final",
      zh: "ICPC 国际大学生程序设计竞赛东亚区决赛",
    },
    award: { en: "Bronze Medal", zh: "铜奖" },
  },
  {
    year: "2024",
    event: {
      en: "NTIRE 2024 RAIM Challenge",
      zh: "NTIRE 2024 RAIM 挑战赛",
    },
    award: { en: "Third-Class Award", zh: "三等奖" },
  },
] as const;

export const teaching = [
  {
    year: "2026",
    term: { en: "Spring & Fall 2026", zh: "2026 年春季、秋季" },
    title: {
      en: "CSCI3260: Principles of Computer Graphics",
      zh: "CSCI3260: Principles of Computer Graphics",
    },
    institution: {
      en: "The Chinese University of Hong Kong",
      zh: "香港中文大学",
    },
  },
  {
    year: "2025",
    term: { en: "Fall 2025", zh: "2025 年秋季" },
    title: {
      en: "CSCI1120: Introduction to Computing Using C++",
      zh: "CSCI1120: Introduction to Computing Using C++",
    },
    institution: {
      en: "The Chinese University of Hong Kong",
      zh: "香港中文大学",
    },
  },
  {
    year: "2024",
    term: { en: "Spring 2024", zh: "2024 年春季" },
    title: { en: "Data Structures", zh: "数据结构" },
    institution: { en: "Wuhan University", zh: "武汉大学" },
  },
] as const;
