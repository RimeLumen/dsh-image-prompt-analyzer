
export const CLASSIFICATION_RULES = Object.freeze([
  { category: 'suppression', confidence: 0.9, pattern: /^(worst_quality|low_quality|lowres|bad_anatomy|bad_hands|bad_proportions|bad_face|bad_feet|extra_digits|fewer_digits|missing_fingers|extra_limbs|extra_arms|extra_legs|extra_hands|fused_fingers|mutated_hands|mutated|long_neck|watermark|signature|username|artist_name|text|error|cropped|out_of_frame|jpeg_artifacts|blurry|chromatic_aberration)$/, note: '负面语义标签' },

  { category: 'camera', confidence: 0.9, pattern: /^(close-?up|extreme_close-?up|full_body|upper_body|cowboy_shot|portrait|wide_shot|medium_shot|from_above|from_below|from_side|from_behind|from_below|dutch_angle|foreshortening|perspective|vanishing_point|fisheye|wide-angle|wide_angle|telephoto|macro|depth_of_field|shallow_depth_of_field|bokeh|blurry_background|lens_flare|motion_blur|panorama|aerial_view|bird's-eye_view|worm's-eye_view|looking_at_viewer|looking_away|looking_back|looking_down|looking_up|looking_to_the_side)$/, note: '镜头与视角' },

  { category: 'composition', confidence: 0.9, pattern: /^(symmetry|symmetrical|asymmetry|asymmetrical|rule_of_thirds|centered|off-center|off_center|framing|border|letterboxed|pillarboxed|negative_space|empty_space|multiple_views|split_screen|diagonal_composition|leading_lines|golden_ratio|silhouette_composition|composition)$/, note: '构图' },
  { category: 'composition', confidence: 0.75, pattern: /(^|_)(background|foreground)$/, note: '前中后景层次' },

  { category: 'subject', confidence: 0.95, pattern: /^(solo|solo_focus|multiple_girls|multiple_boys|multiple_others|\d+(girl|boy|other)s?|male_focus|female_focus|male|female|androgynous|child|adult|elderly|baby|toddler|group|crowd|duo|trio|mob)$/, note: '主体数量与身份' },

  { category: 'expression', confidence: 0.9, pattern: /^(smile|grin|smirk|frown|pout|crying|tears|teary_eyes|blush|angry|annoyed|surprised|shocked|scared|fearful|embarrassed|happy|sad|joy|anger|expressionless|open_mouth|closed_mouth|parted_lips|wink|one_eye_closed|half-closed_eyes|closed_eyes|rolling_eyes|heart-shaped_pupils|tongue_out|tongue|licking_lips|biting_lip|seductive_smile|evil_smile|nervous|confused|thinking|disgust|smug|yawn|sigh|screaming|shouting)$/, note: '表情' },

  { category: 'clothing', confidence: 0.9, pattern: /^(dress|shirt|t-shirt|blouse|sweater|hoodie|jacket|coat|cardigan|vest|suit|uniform|kimono|yukata|qipao|hanfu|sailor_dress|school_uniform|maid|maid_uniform|nurse|serafuku|skirt|pleated_skirt|miniskirt|pants|jeans|shorts|leggings|thighhighs|pantyhose|stockings|socks|shoes|boots|sandals|sneakers|heels|high_heels|hat|cap|beret|helmet|crown|glasses|sunglasses|goggles|eyepatch|gloves|fingerless_gloves|scarf|necktie|bowtie|bow|ribbon|hair_ribbon|hairband|hair_ornament|hairpin|flower_hair_ornament|necklace|earrings|choker|bracelet|ring|belt|sash|cape|cloak|armor|swimsuit|bikini|one-piece_swimsuit|lingerie|underwear|bra|panties|boxers|apron|labcoat|backpack|bag|handbag|purse|umbrella|mask|surgical_mask|veil|headphones|earphones|tiara|badge|armband|legwear|footwear|clothing|outfit|cosplay|nail_polish)$/, note: '服装与佩戴物' },
  { category: 'clothing', confidence: 0.7, pattern: /(_dress|_shirt|_skirt|_pants|_shoes|_boots|_gloves|_socks|_hat|_ribbon|_bow|_collar|_sleeves|_uniform|_swimsuit|_bikini|_bra|_panties|_stockings|_thighhighs|_cape|_armor|_jewelry|_earrings|_necklace)$/, note: '服装词根后缀' },

  { category: 'pose_action', confidence: 0.9, pattern: /^(standing|sitting|kneeling|squatting|crouching|lying|on_back|on_stomach|on_side|on_front|walking|running|jumping|leaping|dancing|floating|flying|falling|leaning|leaning_forward|leaning_back|bending|stretching|reaching|holding|hugging|carrying|embracing|kissing|eating|drinking|sleeping|reading|writing|typing|cooking|fighting|sword_fighting|pointing|waving|saluting|clapping|praying|holding_hands|arms_up|arms_behind_back|arms_crossed|arm_up|arm_at_side|hands_on_hips|hands_up|hand_on_hip|hand_up|hand_on_own_face|hand_on_own_chest|spread_arms|spread_legs|crossed_legs|crossed_arms|legs_up|legs_apart|knees_up|bent_over|turning_head|turning_around|facing_viewer|facing_away|facing_side|peace_sign|v_sign|thumbs_up|ok_sign|middle_finger|outstretched_arm|outstretched_hand|reaching_towards_viewer|waving_hand|pose|action|gesture)$/, note: '动作与姿态' },
  { category: 'pose_action', confidence: 0.7, pattern: /^(holding_|carrying_|riding_|wearing_|putting_on_|taking_off_|reaching_|touching_|grabbing_|pulling_|pushing_)/, note: '动作动词前缀' },

  { category: 'lighting_color', confidence: 0.9, pattern: /^(lighting|backlighting|rim_light|rim_lighting|sunlight|moonlight|starlight|neon_lights|neon|glow|glowing|glowing_eyes|light_particles|light_rays|god_rays|sunbeam|shadow|shadows|cast_shadow|drop_shadow|silhouette|backlit|contre-jour|monochrome|greyscale|grayscale|sepia|colorful|vibrant_colors|pale_color|muted_color|pastel_colors|gradient|gradient_background|two-tone|duotone|warm_colors|cool_colors|dark|bright|high_contrast|low_contrast|bloom|afterimage|chromatic)$/, note: '光影与色彩' },
  { category: 'lighting_color', confidence: 0.7, pattern: /(_light|_lighting|_shadow|_shadows|_glow|_tone|_colored|_coloured)$/, note: '光影色彩词根后缀' },

  { category: 'background', confidence: 0.9, pattern: /^(background|simple_background|white_background|black_background|grey_background|gradient_background|checkered_background|transparent_background|indoors|outdoors|scenery|landscape|cityscape|city|town|street|alley|building|skyscraper|house|room|bedroom|living_room|kitchen|bathroom|classroom|office|library|cafe|restaurant|shop|store|station|hospital|shrine|temple|church|castle|ruins|forest|jungle|woods|tree|trees|cherry_blossoms|flower|flowers|flower_field|grass|field|meadow|mountain|mountains|hill|desert|beach|ocean|sea|lake|river|waterfall|underwater|sky|cloud|clouds|night_sky|starry_sky|sunset|sunrise|day|night|evening|morning|rain|snow|fog|mist|wind|storm|window|curtain|door|wall|floor|ceiling|stairs|bed|chair|table|desk|sofa|couch|bookshelf|shelf|lamp|mirror|painting|poster|plant|potted_plant|vase|food|cup|bottle|skybox|stage|arena|stadium|market|park|garden|pool|onsen|bath|bathroom|toilet|vehicle|car|train|airplane|boat|bicycle|motorcycle)$/, note: '背景与场景' },

  { category: 'appearance', confidence: 0.9, pattern: /^(hair|long_hair|short_hair|very_long_hair|very_short_hair|medium_hair|absurdly_long_hair|twintails|ponytail|side_ponytail|braid|twin_braids|french_braid|bun|hair_bun|double_bun|hime_cut|bob_cut|ahoge|hair_intakes|hair_between_eyes|bangs|blunt_bangs|sidelocks|wavy_hair|curly_hair|straight_hair|messy_hair|floating_hair|wet_hair|colored_inner_hair|gradient_hair|multicolored_hair|two-tone_hair|streaked_hair|hair_over_one_eye|hair_over_eye|hair_covering_face|eyes|eye_|_eyes|blue_eyes|red_eyes|green_eyes|brown_eyes|yellow_eyes|purple_eyes|pink_eyes|orange_eyes|black_eyes|white_eyes|grey_eyes|heterochromia|eyebrows|eyelashes|thick_eyebrows|skin|pale_skin|dark_skin|tan|tanlines|freckles|mole|mole_under_eye|birthmark|scar|blush_stickers|fang|fangs|pointy_ears|elf|animal_ears|cat_ears|fox_ears|dog_ears|rabbit_ears|wolf_ears|mouse_ears|horse_ears|tail|cat_tail|fox_tail|horns|demon_horns|dragon_horns|wings|angel_wings|demon_wings|halo|breasts|large_breasts|huge_breasts|gigantic_breasts|medium_breasts|small_breasts|flat_chest|cleavage|underboob|sideboob|nipples|areolae|navel|waist|hips|thighs|thick_thighs|wide_hips|ass|butt|large_ass|muscular|muscular_female|abs|toned|slim|skinny|chubby|fat|tall|short|petite|glasses_off|beard|mustache|stubble|body_hair|chest_hair|pubic_hair|head_wings|extra_ears|multiple_tails|multiple_horns|slit_pupils|glowing_eyes|empty_eyes|solid_circle_eyes|symbol-shaped_pupils|heart-shaped_pupils|constricted_pupils|dilated_pupils)$/, note: '外貌与体型' },
  { category: 'appearance', confidence: 0.7, pattern: /(_hair|_eyes|_skin|_ears|_tail|_horns|_wings|_breasts|_thighs|_pupils)$/, note: '外貌词根后缀' },
])

export const NATIVE_CATEGORY_MAP = Object.freeze({
  meta: 'quality_style',
  artist: 'artist',
  copyright: 'copyright',
  character: 'character',
  general: null,
})

const QUALITY_STYLE_PATTERN = /^(masterpiece|best_quality|good_quality|normal_quality|low_quality|worst_quality|highres|absurdres|lowres|official_art|anime_screenshot|anime_style|realistic|photorealistic|semi-realistic|3d|3d_(render|model)|cel_shading|flat_color|sketch|lineart|line_art|watercolor|oil_painting|ink|pixel_art|chibi|cartoon|comic|manga|monochrome_lineart|traditional_media|vector_trace|aesthetic|very_aesthetic|year_\d{4}|newest|recent|mid|early|old|score_\d+|safe|sensitive|nsfw|explicit|general|questionable|absurdres|highres)$/

export function classifyTag(tag) {
  const name = String(tag?.name ?? '').trim().toLowerCase().replace(/\s+/g, '_')
  const native = String(tag?.native_category ?? '').trim().toLowerCase()

  if (name.length === 0) return { category: 'unsorted', confidence: 0, rule: 'empty' }

  const nativeMapped = NATIVE_CATEGORY_MAP[native]
  if (nativeMapped) return { category: nativeMapped, confidence: 0.95, rule: `native:${native}` }

  for (const rule of CLASSIFICATION_RULES) {
    if (rule.pattern.test(name)) {
      return { category: rule.category, confidence: rule.confidence, rule: rule.note }
    }
  }

  if (QUALITY_STYLE_PATTERN.test(name)) {
    return { category: 'quality_style', confidence: 0.85, rule: '质量与风格词根' }
  }

  return { category: 'unsorted', confidence: 0, rule: 'no_rule_matched' }
}

export function ruleStats() {
  const counts = new Map()
  for (const rule of CLASSIFICATION_RULES) {
    counts.set(rule.category, (counts.get(rule.category) ?? 0) + 1)
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))
}
