import { Link } from 'react-router';
import { ArrowRight, CalendarCheck, FileCheck2, Users, UserCog } from 'lucide-react';
import { PageHeader } from '../components/layout/PageContainer';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';

export default function OverviewPage({ owner }: { owner: boolean }) {
  return (
    <>
      <PageHeader
        title="Genel Bakış"
        description="Müşterileriniz, yenilemeleriniz ve günlük işleriniz. Hepsi aynı çalışma alanında."
      />
      <section className="overview-welcome" aria-labelledby="welcome-title">
        <div>
          <p className="overview-eyebrow">ACENTENİZİN GÜNLÜK AKIŞI</p>
          <h2 id="welcome-title">Yeni güne, net bir planla.</h2>
          <p>
            Öncelikli takiplerinizi gözden geçirin; müşteri görüşmelerinizi ve tekliflerinizi
            kaldığınız yerden sürdürün.
          </p>
          <Button asChild>
            <Link to="/today-work">
              Bugünkü işleri aç <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <CalendarCheck className="overview-illustration" aria-hidden="true" strokeWidth={1} />
      </section>
      <div className="overview-grid">
        <Card>
          <CardHeader>
            <Users className="overview-icon" aria-hidden="true" />
            <CardTitle>Müşteri ilişkileri</CardTitle>
            <CardDescription>
              Müşteri kartları, ortak notlar ve geçmiş görüşmelerle acente hafızasını birlikte
              güncel tutun.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link to="/customers">
                Müşterilere git <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <FileCheck2 className="overview-icon" aria-hidden="true" />
            <CardTitle>Poliçe takibi</CardTitle>
            <CardDescription>
              Poliçe dönemlerini inceleyin, müşteri kayıtlarıyla bağlantılı yeni poliçeler
              oluşturun.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link to="/policies">
                Poliçelere git <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Bir sonraki adımınız</CardTitle>
          <CardDescription>
            {owner
              ? 'Ekip çalışmalarını Bugünkü İşler üzerinden izleyebilir, hesapları ve izinleri yönetim bölümünden düzenleyebilirsiniz.'
              : 'Size atanmış görevler ve kişisel iş sayımları Bugünkü İşler’de. Ortak müşteri kayıtlarında ekibinizle birlikte çalışabilirsiniz.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {owner ? (
            <Button asChild variant="ghost">
              <Link to="/personnel">
                <UserCog aria-hidden="true" /> Personel ve izinleri yönet{' '}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          ) : (
            <p className="m-0 text-sm text-muted-foreground">
              Müşteri notu eklerken yalnız iş için gerekli bilgileri paylaşın.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
