/**
 * Система управления промптами: загрузка из БД (prompt_templates) и подстановка переменных.
 * Переменные в шаблоне: {{var_name}}. Значения передаются объектом { var_name: "value" }.
 *
 * Главный промпт проекта: «Идеально отлаженный промт» — техническое имя в БД: MAIN_PROMPT_NAME.
 */

/** Техническое имя главного промпта в таблице prompt_templates («Идеально отлаженный системный промт»: анализ + песня + Suno). */
export const MAIN_PROMPT_NAME = "ideally_tuned_system_v1";

/** Человекочитаемое название главного промпта. */
export const MAIN_PROMPT_DISPLAY_NAME = "Идеально отлаженный промт";

/**
 * Подставляет переменные в текст шаблона.
 * Плейсхолдеры вида {{name}}, {{astro_snapshot}} заменяются на values[name], values['astro_snapshot'].
 * Непереданные переменные заменяются на пустую строку.
 * @param {string} body — текст шаблона с {{var}}
 * @param {Record<string, string>} values — объект переменная → значение
 * @returns {string}
 */
function substituteVariables(body, values = {}) {
  if (!body || typeof body !== "string") return "";
  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = values[key];
    return v !== undefined && v !== null ? String(v) : "";
  });
}

/**
 * Загружает один активный шаблон по имени.
 * @param {object} supabase — клиент Supabase (service role)
 * @param {string} name — имя шаблона (например 'deepseek_archetype_v1')
 * @returns {Promise<{ id: string, name: string, body: string, variables: string[] } | null>}
 */
async function loadPrompt(supabase, name) {
  if (!supabase || !name) return null;
  const { data, error } = await supabase
    .from("prompt_templates")
    .select("id, name, body, variables")
    .eq("name", name)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[promptTemplates] loadPrompt error:", name, error.message);
    return null;
  }
  return data;
}

/**
 * Загружает все активные шаблоны (по имени — один на name).
 * @param {object} supabase — клиент Supabase
 * @returns {Promise<Array<{ id: string, name: string, body: string, variables: string[] }>>}
 */
async function loadAllActive(supabase) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("prompt_templates")
    .select("id, name, body, variables")
    .eq("is_active", true)
    .order("name");
  if (error) {
    console.error("[promptTemplates] loadAllActive error:", error.message);
    return [];
  }
  return data || [];
}

/**
 * Загружает шаблон по имени и возвращает тело с подставленными переменными.
 * @param {object} supabase — клиент Supabase
 * @param {string} name — имя шаблона
 * @param {Record<string, string>} variables — переменные для подстановки
 * @returns {Promise<string|null>} итоговый текст или null при ошибке/отсутствии шаблона
 */
async function getRenderedPrompt(supabase, name, variables = {}) {
  const template = await loadPrompt(supabase, name);
  if (!template) return null;
  return substituteVariables(template.body, variables);
}

export {
  substituteVariables,
  loadPrompt,
  loadAllActive,
  getRenderedPrompt,
};
