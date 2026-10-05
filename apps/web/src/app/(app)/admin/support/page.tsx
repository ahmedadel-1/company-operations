'use client';

import { useTranslations } from 'next-intl';

import { Forbidden, PageHeader } from '../../../../components/states';
import {
  CalendarsSection,
  CategoriesSection,
  ComponentsSection,
  PoliciesSection,
  RulesSection,
} from '../../../../components/support-config';
import { useCanOrgWide } from '../../../../lib/session';

export default function SupportConfigPage() {
  const t = useTranslations('support.config');
  const orgWide = useCanOrgWide();
  if (!orgWide('support.config')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="flex flex-col gap-6">
        <CategoriesSection />
        <ComponentsSection />
        <CalendarsSection />
        <PoliciesSection />
        <RulesSection />
      </div>
    </>
  );
}
